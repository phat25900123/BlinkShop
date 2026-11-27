import "server-only";

import { getSponsorLimits } from "@/lib/backend/escrow-config";
import { isBelowMinimumOrder } from "@/lib/backend/sponsor-limits";
import {
  defaultSponsorSigningDependencies,
  SponsoredSubmissionError,
  verifyAndSponsorTransaction,
  type SponsorSigningDependencies,
} from "@/lib/backend/sponsor-signing";
import {
  expectedCreateOrderInstruction,
  getSponsoredEscrowAccounts,
} from "@/lib/backend/sponsored-checkout";
import { store } from "@/lib/backend/store";
import type { Order, Product } from "@/lib/backend/types";

export {
  MAX_SPONSORED_FEE_LAMPORTS,
  SponsoredSubmissionError,
  type SponsoredSubmissionErrorCode,
} from "@/lib/backend/sponsor-signing";

export type SponsoredSubmissionDependencies = SponsorSigningDependencies & {
  getCurrentOrder: (orderId: string) => Order | undefined;
};

function defaultDependencies(): SponsoredSubmissionDependencies {
  return {
    ...defaultSponsorSigningDependencies(),
    getCurrentOrder: (orderId) => store.getOrder(orderId),
  };
}

function requireOrderForBuyer(
  order: Order,
  product: Product,
  authenticatedBuyerWallet: string,
) {
  if (order.productId !== product.id) {
    throw new SponsoredSubmissionError(
      "order_product_mismatch",
      "The order does not belong to this product.",
    );
  }
  if (
    order.merchantId !== product.merchantId ||
    order.merchantWallet !== product.merchantWallet
  ) {
    throw new SponsoredSubmissionError(
      "order_merchant_mismatch",
      "The order payout destination does not match this product.",
    );
  }
  if (order.buyerWallet !== authenticatedBuyerWallet) {
    throw new SponsoredSubmissionError(
      "order_buyer_mismatch",
      "The order belongs to another buyer wallet.",
    );
  }
  if (order.status !== "pending") {
    throw new SponsoredSubmissionError(
      "order_not_pending",
      "Only a pending order can be submitted.",
    );
  }
  if (Date.parse(order.expiresAt) <= Date.now()) {
    throw new SponsoredSubmissionError(
      "order_expired",
      "The pending order has expired.",
    );
  }
}

export async function submitSponsoredCheckoutTransaction(
  input: {
    order: Order;
    product: Product;
    authenticatedBuyerWallet: string;
    signedTransaction: string;
  },
  injectedDependencies?: SponsoredSubmissionDependencies,
) {
  requireOrderForBuyer(
    input.order,
    input.product,
    input.authenticatedBuyerWallet,
  );

  // Only orders created by the sponsored checkout (which applied the buyer
  // and global sponsorship limits) may make the sponsor sign.
  if (!input.order.sponsored || input.order.settlement !== "escrow") {
    throw new SponsoredSubmissionError(
      "order_not_sponsored",
      "This order was not created for sponsored checkout.",
    );
  }

  // Re-check the sponsored minimum here: limits may have changed since the
  // checkout, and the sponsor must never fund rent for a below-minimum order.
  if (isBelowMinimumOrder(input.order.amountUsdc, getSponsorLimits())) {
    throw new SponsoredSubmissionError(
      "order_below_minimum",
      "The order total is below the minimum BlinkShop sponsors.",
    );
  }

  const dependencies = injectedDependencies ?? defaultDependencies();
  const sponsor = dependencies.getSponsorKeypair();
  const expected = await getSponsoredEscrowAccounts(
    input.order.id,
    input.authenticatedBuyerWallet,
    input.order.merchantWallet,
    input.order.amountUsdc,
  );

  return verifyAndSponsorTransaction(
    {
      signedTransaction: input.signedTransaction,
      signer: expected.buyer,
      expectedInstruction: expectedCreateOrderInstruction(
        expected,
        sponsor.publicKey,
      ),
      boundMessageHash: input.order.sponsoredTransactionHash,
      recheck: () => {
        const currentOrder = dependencies.getCurrentOrder(input.order.id);
        if (!currentOrder) {
          throw new SponsoredSubmissionError(
            "order_not_pending",
            "The pending order is no longer available.",
          );
        }
        requireOrderForBuyer(
          currentOrder,
          input.product,
          input.authenticatedBuyerWallet,
        );
        if (
          currentOrder.sponsoredTransactionHash !==
          input.order.sponsoredTransactionHash
        ) {
          throw new SponsoredSubmissionError(
            "transaction_message_mismatch",
            "The prepared transaction changed before sponsor signing.",
          );
        }
      },
      messages: {
        wrongProgram:
          "Only the BlinkShop escrow create_order instruction can be sponsored.",
        mismatch: "The signed transaction does not match the pending order.",
        expired:
          "The payment transaction expired before submission. Wait for the order to expire, then try again.",
        broadcastFailed:
          "The transaction broadcast result is unknown. The order remains pending so it can be checked or retried safely.",
      },
    },
    dependencies,
  );
}
