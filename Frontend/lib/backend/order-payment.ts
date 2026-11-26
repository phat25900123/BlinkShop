import "server-only";

import {
  verifyEscrowPayment,
  verifyUsdcPayment,
  type PaymentVerification,
} from "@/lib/backend/solana";
import type { Order } from "@/lib/backend/types";

type PayableOrder = Pick<
  Order,
  "id" | "buyerWallet" | "merchantWallet" | "amountUsdc" | "settlement"
>;

/**
 * Verifies a payment by the method the order was created with. Escrow orders
 * (every new order) are proven from the on-chain escrow PDA and vault; legacy
 * "direct" orders, created before the escrow integration, keep the original
 * transfer verification. The settlement is read from the server order, never
 * from the request.
 */
export function verifyOrderPayment(
  signature: string,
  order: PayableOrder,
): Promise<PaymentVerification> {
  if (order.settlement === "escrow") {
    return verifyEscrowPayment(signature, {
      orderId: order.id,
      buyerWallet: order.buyerWallet,
      merchantWallet: order.merchantWallet,
      amountUsdc: order.amountUsdc,
    });
  }

  return verifyUsdcPayment(signature, {
    buyerWallet: order.buyerWallet,
    merchantWallet: order.merchantWallet,
    amountUsdc: order.amountUsdc,
  });
}

export async function verifyOrderPaymentWithRetry(
  signature: string,
  order: PayableOrder,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await verifyOrderPayment(signature, order);
    if (result !== "pending") return result;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return "pending" as const;
}
