import { NextResponse } from "next/server";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Content-Type": "application/json",
};

export async function GET() {
  return NextResponse.json({ rules: [
    { pathPattern: "/blink/*", apiPath: "/api/actions/product/*" },
    { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
  ] }, { headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}