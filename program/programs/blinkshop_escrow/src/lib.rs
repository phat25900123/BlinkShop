//! BlinkShop Escrow
//!
//! A commerce-aware USDC escrow for social-commerce orders.
//!
//! Lifecycle of an order:
//!
//! ```text
//!   create_order      mark_shipped        confirm_receipt (buyer)
//!   (buyer pays   ->  (merchant)      ->  or claim (after window)  -> Released
//!    into vault)  Funded         Shipped
//!        |                |
//!        +---- refund ----+--> Refunded
//! ```
//!
//! * Funds sit in a vault token account owned by the order PDA, so neither the
//!   merchant nor the BlinkShop backend can move them outside these rules.
//! * The order account is kept after settlement as a permanent, verifiable
//!   on-chain receipt. Only the vault is closed (its rent goes back to
//!   whoever paid it, e.g. the BlinkShop fee sponsor).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw");

pub const ORDER_SEED: &[u8] = b"order";
pub const VAULT_SEED: &[u8] = b"vault";

/// Bounds (in seconds) for the ship and buyer-protection windows.
pub const MIN_WINDOW: i64 = 1;
pub const MAX_WINDOW: i64 = 30 * 24 * 60 * 60;

#[program]
pub mod blinkshop_escrow {
    use super::*;

    /// Buyer funds a new order. USDC moves from the buyer into a vault owned
    /// by the order PDA. `rent_payer` (e.g. the BlinkShop sponsor) pays account
    /// rent so buyers with no SOL can still check out.
    ///
    /// * `order_id`: 32-byte id chosen by the backend (e.g. a hash of the order).
    /// * `ship_window`: seconds the merchant has to mark the order shipped
    ///   before the buyer may reclaim the funds.
    /// * `protection_window`: seconds after shipping during which the buyer
    ///   can confirm receipt; after it ends the merchant can claim.
    pub fn create_order(
        ctx: Context<CreateOrder>,
        order_id: [u8; 32],
        amount: u64,
        ship_window: i64,
        protection_window: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            (MIN_WINDOW..=MAX_WINDOW).contains(&ship_window)
                && (MIN_WINDOW..=MAX_WINDOW).contains(&protection_window),
            EscrowError::InvalidWindow
        );

        let now = Clock::get()?.unix_timestamp;
        let ship_by = now
            .checked_add(ship_window)
            .ok_or(EscrowError::InvalidWindow)?;

        let order = &mut ctx.accounts.order;
        order.order_id = order_id;
        order.merchant = ctx.accounts.merchant.key();
        order.buyer = ctx.accounts.buyer.key();
        order.rent_payer = ctx.accounts.rent_payer.key();
        order.mint = ctx.accounts.mint.key();
        order.amount = amount;
        order.status = OrderStatus::Funded;
        order.created_at = now;
        order.ship_by = ship_by;
        order.protection_window = protection_window;
        order.release_after = 0;
        order.bump = ctx.bumps.order;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(OrderCreated {
            order: ctx.accounts.order.key(),
            order_id,
            merchant: ctx.accounts.merchant.key(),
            buyer: ctx.accounts.buyer.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }

    /// Merchant marks the order as shipped. Starts the buyer-protection window.
    pub fn mark_shipped(ctx: Context<MarkShipped>) -> Result<()> {
        let order = &mut ctx.accounts.order;
        require!(order.status == OrderStatus::Funded, EscrowError::InvalidStatus);

        let now = Clock::get()?.unix_timestamp;
        order.release_after = now
            .checked_add(order.protection_window)
            .ok_or(EscrowError::InvalidWindow)?;
        order.status = OrderStatus::Shipped;

        emit!(OrderStatusChanged {
            order: order.key(),
            status: OrderStatus::Shipped,
        });
        Ok(())
    }

    /// Buyer confirms they received the goods: funds go to the merchant now.
    pub fn confirm_receipt(ctx: Context<Settle>) -> Result<()> {
        let order = &ctx.accounts.order;
        require_keys_eq!(ctx.accounts.caller.key(), order.buyer, EscrowError::Unauthorized);
        require!(order.status == OrderStatus::Shipped, EscrowError::InvalidStatus);
        require_keys_eq!(
            ctx.accounts.destination_token.owner,
            order.merchant,
            EscrowError::WrongDestination
        );

        pay_out_and_close_vault(&ctx.accounts)?;
        finish(&mut ctx.accounts.order, OrderStatus::Released);
        Ok(())
    }

    /// After the buyer-protection window has passed, anyone can trigger the
    /// payout to the merchant (the funds can only ever go to the merchant).
    pub fn claim(ctx: Context<Settle>) -> Result<()> {
        let order = &ctx.accounts.order;
        require!(order.status == OrderStatus::Shipped, EscrowError::InvalidStatus);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= order.release_after, EscrowError::WindowNotElapsed);
        require_keys_eq!(
            ctx.accounts.destination_token.owner,
            order.merchant,
            EscrowError::WrongDestination
        );

        pay_out_and_close_vault(&ctx.accounts)?;
        finish(&mut ctx.accounts.order, OrderStatus::Released);
        Ok(())
    }

    /// Return the funds to the buyer.
    /// * The merchant may refund at any time before release (cancel / sold out).
    /// * The buyer may refund only if the merchant never shipped in time.
    pub fn refund(ctx: Context<Settle>) -> Result<()> {
        let order = &ctx.accounts.order;
        require!(
            order.status == OrderStatus::Funded || order.status == OrderStatus::Shipped,
            EscrowError::InvalidStatus
        );

        let caller = ctx.accounts.caller.key();
        let now = Clock::get()?.unix_timestamp;
        let merchant_cancels = caller == order.merchant;
        let buyer_reclaims =
            caller == order.buyer && order.status == OrderStatus::Funded && now > order.ship_by;
        require!(merchant_cancels || buyer_reclaims, EscrowError::Unauthorized);
        require_keys_eq!(
            ctx.accounts.destination_token.owner,
            order.buyer,
            EscrowError::WrongDestination
        );

        pay_out_and_close_vault(&ctx.accounts)?;
        finish(&mut ctx.accounts.order, OrderStatus::Refunded);
        Ok(())
    }
}

/// Moves the full escrowed amount from the vault to `destination_token`, then
/// closes the vault and returns its rent to the original rent payer.
fn pay_out_and_close_vault(accs: &Settle) -> Result<()> {
    let amount = accs.order.amount;
    let merchant = accs.order.merchant;
    let order_id = accs.order.order_id;
    let bump = [accs.order.bump];
    let seeds: &[&[u8]] = &[ORDER_SEED, merchant.as_ref(), order_id.as_ref(), &bump];
    let signer_seeds = &[seeds];

    token::transfer_checked(
        CpiContext::new_with_signer(
            accs.token_program.to_account_info(),
            TransferChecked {
                from: accs.vault.to_account_info(),
                mint: accs.mint.to_account_info(),
                to: accs.destination_token.to_account_info(),
                authority: accs.order.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        accs.mint.decimals,
    )?;

    token::close_account(CpiContext::new_with_signer(
        accs.token_program.to_account_info(),
        CloseAccount {
            account: accs.vault.to_account_info(),
            destination: accs.rent_payer.to_account_info(),
            authority: accs.order.to_account_info(),
        },
        signer_seeds,
    ))
}

fn finish(order: &mut Account<Order>, status: OrderStatus) {
    order.status = status;
    emit!(OrderStatusChanged {
        order: order.key(),
        status,
    });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct CreateOrder<'info> {
    /// Pays the USDC. Signs the token transfer.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// Pays account rent (BlinkShop sponsor in the sponsored checkout flow).
    #[account(mut)]
    pub rent_payer: Signer<'info>,

    /// CHECK: only the address is stored; it never signs here.
    pub merchant: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = rent_payer,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, merchant.key().as_ref(), order_id.as_ref()],
        bump
    )]
    pub order: Account<'info, Order>,

    #[account(
        init,
        payer = rent_payer,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = order
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkShipped<'info> {
    pub merchant: Signer<'info>,

    #[account(mut, has_one = merchant @ EscrowError::Unauthorized)]
    pub order: Account<'info, Order>,
}

/// Shared by `confirm_receipt`, `claim` and `refund`. Each handler checks who
/// may call it and that `destination_token` belongs to the right party.
#[derive(Accounts)]
pub struct Settle<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [ORDER_SEED, order.merchant.as_ref(), order.order_id.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,

    #[account(address = order.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = order
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = mint)]
    pub destination_token: Account<'info, TokenAccount>,

    /// CHECK: receives the vault rent back; address is pinned to the order.
    #[account(mut, address = order.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub order_id: [u8; 32],
    pub merchant: Pubkey,
    pub buyer: Pubkey,
    pub rent_payer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub status: OrderStatus,
    pub created_at: i64,
    pub ship_by: i64,
    pub protection_window: i64,
    pub release_after: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum OrderStatus {
    Funded,
    Shipped,
    Released,
    Refunded,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct OrderCreated {
    pub order: Pubkey,
    pub order_id: [u8; 32],
    pub merchant: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct OrderStatusChanged {
    pub order: Pubkey,
    pub status: OrderStatus,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Window is outside the allowed range")]
    InvalidWindow,
    #[msg("Order is not in a valid status for this action")]
    InvalidStatus,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Destination token account has the wrong owner")]
    WrongDestination,
    #[msg("Buyer-protection window has not elapsed yet")]
    WindowNotElapsed,
}
