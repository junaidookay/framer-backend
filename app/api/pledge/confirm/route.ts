import { NextResponse } from "next/server"
import { getStripe } from "@/src/lib/stripe"
import { getSupabaseAdmin } from "@/src/lib/supabaseAdmin"
import type Stripe from "stripe"

export const runtime = "nodejs"

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? ""
  const requestHeaders = req.headers.get("access-control-request-headers")
  const allowed = new Set([
    "https://www.sixplusone.com",
    "https://sixplusone.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ])

  const allowOrigin = allowed.has(origin) ? origin : "https://www.sixplusone.com"

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders ?? "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  }
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

type Body = { session_id: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function getStringId(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "object" && value != null && "id" in value) {
    const id = (value as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return null
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  try {
    const body = (await req.json()) as Partial<Body>
    if (!isNonEmptyString(body.session_id)) {
      return NextResponse.json(
        { error: "session_id is required", requestId },
        { status: 400, headers: corsHeaders(req) }
      )
    }

    const stripe = getStripe()
    const supabaseAdmin = getSupabaseAdmin()

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.retrieve(body.session_id)
    } catch {
      return NextResponse.json(
        { error: "Unable to retrieve checkout session", requestId },
        { status: 502, headers: corsHeaders(req) }
      )
    }

    const metadata = (session as { metadata?: Record<string, string> }).metadata
    const flow = metadata?.flow
    const pledgeId = metadata?.pledge_id

    if (flow !== "pledge_setup" || !pledgeId) {
      return NextResponse.json(
        { error: "Session is not a pledge setup", requestId },
        { status: 400, headers: corsHeaders(req) }
      )
    }

    const setupIntentId = getStringId((session as { setup_intent?: unknown }).setup_intent)
    const customerId = getStringId((session as { customer?: unknown }).customer)

    if (!setupIntentId) {
      await supabaseAdmin
        .from("pledges")
        .update({
          setup_status: "failed",
          error_message: "Missing setup_intent on checkout session",
        })
        .eq("id", pledgeId)

      return NextResponse.json(
        { error: "Missing setup intent", requestId },
        { status: 409, headers: corsHeaders(req) }
      )
    }

    let setupIntent: Stripe.SetupIntent
    try {
      setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
    } catch {
      return NextResponse.json(
        { error: "Unable to retrieve setup intent", requestId },
        { status: 502, headers: corsHeaders(req) }
      )
    }

    const paymentMethodId = getStringId(
      (setupIntent as { payment_method?: unknown }).payment_method
    )

    if (!customerId || !paymentMethodId) {
      await supabaseAdmin
        .from("pledges")
        .update({
          setup_status: "failed",
          error_message: "Missing customer or payment method on setup completion",
        })
        .eq("id", pledgeId)

      return NextResponse.json(
        { error: "Setup completed without payment method", requestId },
        { status: 409, headers: corsHeaders(req) }
      )
    }

    await supabaseAdmin
      .from("pledges")
      .update({
        stripe_customer_id: customerId,
        stripe_payment_method_id: paymentMethodId,
        setup_status: "complete",
        error_message: null,
      })
      .eq("id", pledgeId)

    return NextResponse.json(
      { ok: true, pledge_id: pledgeId, requestId },
      { status: 200, headers: corsHeaders(req) }
    )
  } catch (e) {
    const message =
      typeof e === "object" && e != null && "message" in e
        ? String((e as { message: unknown }).message)
        : "Request failed"

    return NextResponse.json(
      { error: message, requestId },
      { status: 500, headers: corsHeaders(req) }
    )
  }
}

