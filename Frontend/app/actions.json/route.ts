import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ rules: [{ pathPattern: "/api/actions/**", apiPath: "/api/actions/**" }] }, { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
}