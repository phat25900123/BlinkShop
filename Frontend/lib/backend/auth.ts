import "server-only";

import { NextResponse } from "next/server";
import {
  PrivyConfigurationError,
  verifyPrivyAccessToken,
} from "./privy";

type AuthenticatedUser = {
  userId: string;
};

type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: NextResponse };

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

export async function requirePrivyUser(
  request: Request,
): Promise<AuthResult> {
  const accessToken = bearerToken(request);

  if (!accessToken) {
    return {
      ok: false,
      response: errorResponse("Unauthorized", 401),
    };
  }

  try {
    const user = await verifyPrivyAccessToken(accessToken);
    return { ok: true, user };
  } catch (error) {
    if (error instanceof PrivyConfigurationError) {
      return {
        ok: false,
        response: errorResponse(
          "Privy authentication is not configured",
          503,
        ),
      };
    }

    return {
      ok: false,
      response: errorResponse("Unauthorized", 401),
    };
  }
}

export const requireAuthenticatedUser = requirePrivyUser;

// A merchant workspace is available to every authenticated Privy user.
// Resource ownership is enforced by each product/order route, not by a global
// DID allowlist. Keep this alias for callers that describe merchant intent.
export const requireMerchant = requirePrivyUser;
