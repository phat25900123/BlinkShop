#!/usr/bin/env python3
"""Fallback IDL generator for blinkshop_escrow.

`anchor build` (0.30.x) fails to produce the IDL on some toolchains because a
transitive crate (ark-bn254) breaks under the IDL-build flags. This script
writes the same Anchor 0.30 IDL by hand, from the program's public interface
in programs/blinkshop_escrow/src/lib.rs. Keep it in sync with lib.rs.

Usage (from the program/ directory):  python3 scripts/gen_idl.py
Writes: target/idl/blinkshop_escrow.json and target/types/blinkshop_escrow.ts
"""
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

toml = (ROOT / "Anchor.toml").read_text()
m = re.search(r'blinkshop_escrow\s*=\s*"([^"]+)"', toml)
if not m:
    raise SystemExit("program address not found in Anchor.toml")
ADDRESS = m.group(1)

TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SYSTEM_PROGRAM = "11111111111111111111111111111111"


def disc(namespace, name):
    return list(hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8])


def acct(name, writable=False, signer=False, address=None):
    a = {"name": name}
    if writable:
        a["writable"] = True
    if signer:
        a["signer"] = True
    if address:
        a["address"] = address
    return a


SETTLE_ACCOUNTS = [
    acct("caller", signer=True),
    acct("order", writable=True),
    acct("mint"),
    acct("vault", writable=True),
    acct("destination_token", writable=True),
    acct("rent_payer", writable=True),
    acct("token_program", address=TOKEN_PROGRAM),
]

PUBKEY, U64, I64, U8 = "pubkey", "u64", "i64", "u8"
ID32 = {"array": ["u8", 32]}
STATUS = {"defined": {"name": "OrderStatus"}}


def ix(name, accounts, args):
    return {"name": name, "discriminator": disc("global", name), "accounts": accounts, "args": args}


idl = {
    "address": ADDRESS,
    "metadata": {
        "name": "blinkshop_escrow",
        "version": "0.1.0",
        "spec": "0.1.0",
        "description": "Commerce-aware USDC escrow for BlinkShop orders on Solana",
    },
    "instructions": [
        ix("claim", SETTLE_ACCOUNTS, []),
        ix("confirm_receipt", SETTLE_ACCOUNTS, []),
        ix(
            "create_order",
            [
                acct("buyer", writable=True, signer=True),
                acct("rent_payer", writable=True, signer=True),
                acct("merchant"),
                acct("mint"),
                acct("buyer_token", writable=True),
                acct("order", writable=True),
                acct("vault", writable=True),
                acct("token_program", address=TOKEN_PROGRAM),
                acct("system_program", address=SYSTEM_PROGRAM),
            ],
            [
                {"name": "order_id", "type": ID32},
                {"name": "amount", "type": U64},
                {"name": "ship_window", "type": I64},
                {"name": "protection_window", "type": I64},
            ],
        ),
        ix("mark_shipped", [acct("merchant", signer=True), acct("order", writable=True)], []),
        ix("refund", SETTLE_ACCOUNTS, []),
    ],
    "accounts": [{"name": "Order", "discriminator": disc("account", "Order")}],
    "events": [
        {"name": "OrderCreated", "discriminator": disc("event", "OrderCreated")},
        {"name": "OrderStatusChanged", "discriminator": disc("event", "OrderStatusChanged")},
    ],
    "errors": [
        {"code": 6000, "name": "InvalidAmount", "msg": "Amount must be greater than zero"},
        {"code": 6001, "name": "InvalidWindow", "msg": "Window is outside the allowed range"},
        {"code": 6002, "name": "InvalidStatus", "msg": "Order is not in a valid status for this action"},
        {"code": 6003, "name": "Unauthorized", "msg": "Signer is not allowed to perform this action"},
        {"code": 6004, "name": "WrongDestination", "msg": "Destination token account has the wrong owner"},
        {"code": 6005, "name": "WindowNotElapsed", "msg": "Buyer-protection window has not elapsed yet"},
    ],
    "types": [
        {
            "name": "Order",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "order_id", "type": ID32},
                    {"name": "merchant", "type": PUBKEY},
                    {"name": "buyer", "type": PUBKEY},
                    {"name": "rent_payer", "type": PUBKEY},
                    {"name": "mint", "type": PUBKEY},
                    {"name": "amount", "type": U64},
                    {"name": "status", "type": STATUS},
                    {"name": "created_at", "type": I64},
                    {"name": "ship_by", "type": I64},
                    {"name": "protection_window", "type": I64},
                    {"name": "release_after", "type": I64},
                    {"name": "bump", "type": U8},
                ],
            },
        },
        {
            "name": "OrderCreated",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "order", "type": PUBKEY},
                    {"name": "order_id", "type": ID32},
                    {"name": "merchant", "type": PUBKEY},
                    {"name": "buyer", "type": PUBKEY},
                    {"name": "mint", "type": PUBKEY},
                    {"name": "amount", "type": U64},
                ],
            },
        },
        {
            "name": "OrderStatus",
            "type": {
                "kind": "enum",
                "variants": [
                    {"name": "Funded"},
                    {"name": "Shipped"},
                    {"name": "Released"},
                    {"name": "Refunded"},
                ],
            },
        },
        {
            "name": "OrderStatusChanged",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "order", "type": PUBKEY},
                    {"name": "status", "type": STATUS},
                ],
            },
        },
    ],
}

idl_dir = ROOT / "target" / "idl"
types_dir = ROOT / "target" / "types"
idl_dir.mkdir(parents=True, exist_ok=True)
types_dir.mkdir(parents=True, exist_ok=True)

text = json.dumps(idl, indent=2)
(idl_dir / "blinkshop_escrow.json").write_text(text + "\n")
(types_dir / "blinkshop_escrow.ts").write_text(
    "/** Generated by scripts/gen_idl.py */\nexport type BlinkshopEscrow = " + text + "\n"
)
print(f"IDL written for program {ADDRESS}")
