import { NextResponse } from "next/server";

export const actionHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Content-Type": "application/json",
};

export function actionResponse(body: unknown, status = 200) {
  if (status === 204) return new NextResponse(null, { status, headers: actionHeaders });
  return NextResponse.json(body, { status, headers: actionHeaders });
}