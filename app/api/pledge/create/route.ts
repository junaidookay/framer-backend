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

type Body = {
  campaign_id: string
  name: string
  email: string
  rate_per_1000: number
  cap_amount?: number
}

type CampaignRow = { id: string; views_cap: number | null; status: string }
type PledgeRow = { id: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  try {
    const body = (await req.json()) as Partial<Body>

    if (
      !isNonEmptyString(body.campaign_id) ||
      !isNonEmptyString(body.name) ||
      !isNonEmptyString(body.email)
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400, headers: corsHeaders(req) }
      )
    }

    const ratePer1000 = Number(body.rate_per_1000)
    if (!Number.isFinite(ratePer1000) || ratePer1000 < 1) {
      return NextResponse.json(
        { error: "rate_per_1000 must be at least $1" },
        { status: 400, headers: corsHeaders(req) }
      )
    }

    const capAmount =
      body.cap_amount == null || body.cap_amount === ("" as unknown)
        ? null
        : Number(body.cap_amount)

    if (capAmount != null) {
      if (!Number.isFinite(capAmount) || capAmount < 1) {
        return NextResponse.json(
          { error: "cap_amount must be at least $1 when provided" },
          { status: 400, headers: corsHeaders(req) }
        )
      }
    }

    const supabaseAdmin = getSupabaseAdmin()

    let campaign: CampaignRow | null = null
    let campaignError: { message?: string } | null = null

    try {
      const res = await supabaseAdmin
        .from("campaigns")
        .select("id, views_cap, status")
        .eq("id", body.campaign_id)
        .single()

      campaign = res.data as CampaignRow | null
      campaignError = res.error as { message?: string } | null
    } catch (e) {
      const message =
        typeof e === "object" && e != null && "message" in e
          ? String((e as { message: unknown }).message)
          : "Supabase request failed"

      console.error("pledge/create campaign fetch failed", { requestId, message })

      return NextResponse.json(
        { error: "Supabase request failed", requestId },
        { status: 502, headers: corsHeaders(req) }
      )
    }

    if (campaignError || !campaign) {
      return NextResponse.json(
        { error: "Campaign not found" },
        { status: 404, headers: corsHeaders(req) }
      )
    }

    if (campaign.status !== "open") {
      return NextResponse.json(
        { error: "Campaign is not accepting new pledges" },
        { status: 400, headers: corsHeaders(req) }
      )
    }

    const viewsCap =
      campaign.views_cap != null &&
      Number.isFinite(Number(campaign.views_cap)) &&
      Number(campaign.views_cap) > 0
        ? Number(campaign.views_cap)
        : 20000

    const ratePer1000Cents = Math.round(ratePer1000 * 100)
    const capAmountCents = capAmount == null ? null : Math.round(capAmount * 100)

    let pledge: PledgeRow | null = null
    let pledgeError: { message?: string } | null = null

    try {
      const res = await supabaseAdmin
        .from("pledges")
        .insert({
          campaign_id: body.campaign_id,
          name: body.name,
          email: body.email,
          rate_per_1000_cents: ratePer1000Cents,
          cap_amount_cents: capAmountCents,
          views_cap: viewsCap,
          setup_status: "pending",
          charge_status: "not_charged",
        })
        .select("id")
        .single()

      pledge = res.data as PledgeRow | null
      pledgeError = res.error as { message?: string } | null
    } catch (e) {
      const message =
        typeof e === "object" && e != null && "message" in e
          ? String((e as { message: unknown }).message)
          : "Supabase request failed"

      console.error("pledge/create pledge insert failed", { requestId, message })

      return NextResponse.json(
        { error: "Supabase request failed", requestId },
        { status: 502, headers: corsHeaders(req) }
      )
    }

    if (pledgeError || !pledge) {
      return NextResponse.json(
        { error: pledgeError?.message ?? "Failed to create pledge", requestId },
        { status: 500, headers: corsHeaders(req) }
      )
    }

    const stripe = getStripe()

    let customer: Stripe.Customer
    try {
      customer = await stripe.customers.create({
        email: body.email,
        name: body.name,
        metadata: { pledge_id: pledge.id, campaign_id: body.campaign_id },
      })
    } catch {
      return NextResponse.json(
        { error: "Stripe customer creation failed", requestId },
        { status: 502, headers: corsHeaders(req) }
      )
    }

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.create({
        mode: "setup",
        payment_method_types: ["card"],
        customer: customer.id,
        success_url: process.env.SUCCESS_URL as string,
        cancel_url: process.env.CANCEL_URL as string,
        metadata: {
          pledge_id: pledge.id,
          campaign_id: body.campaign_id,
          flow: "pledge_setup",
        },
      })
    } catch (e) {
      const rawMessage =
        typeof e === "object" && e != null && "message" in e
          ? String((e as { message: unknown }).message)
          : "Request failed"

      let message = "Stripe checkout session creation failed"
      if (
        rawMessage.toLowerCase().includes("invalid url") ||
        rawMessage.toLowerCase().includes("success_url") ||
        rawMessage.toLowerCase().includes("cancel_url")
      ) {
        message = "Backend has invalid SUCCESS_URL or CANCEL_URL"
      } else if (
        rawMessage.toLowerCase().includes("invalid api key") ||
        rawMessage.toLowerCase().includes("api key provided") ||
        rawMessage.toLowerCase().includes("secret key")
      ) {
        message = "Backend Stripe secret key is invalid"
      } else if (rawMessage.toLowerCase().includes("payment_method_types")) {
        message = "Stripe setup session requires payment_method_types"
      } else if (rawMessage.toLowerCase().includes("fetch failed")) {
        message = "Stripe request failed due to a network error"
      }

      return NextResponse.json(
        { error: message, requestId },
        { status: 502, headers: corsHeaders(req) }
      )
    }

    try {
      const res = await supabaseAdmin
        .from("pledges")
        .update({ stripe_customer_id: customer.id })
        .eq("id", pledge.id)

      if (res.error) {
        console.error("pledge/create pledge update failed", {
          requestId,
          message: res.error.message,
        })
      }
    } catch (e) {
      const message =
        typeof e === "object" && e != null && "message" in e
          ? String((e as { message: unknown }).message)
          : "Supabase request failed"
      console.error("pledge/create pledge update failed", { requestId, message })
    }

    return NextResponse.json(
      { url: session.url, requestId },
      { status: 200, headers: corsHeaders(req) }
    )
  } catch (e) {
    const rawMessage =
      typeof e === "object" && e != null && "message" in e
        ? String((e as { message: unknown }).message)
        : "Request failed"

    let message = "Unable to create pledge checkout session"

    if (rawMessage.includes("Missing SUPABASE_URL")) {
      message = "Backend is missing Supabase environment variables"
    } else if (rawMessage.includes("Missing STRIPE_SECRET_KEY")) {
      message = "Backend is missing Stripe environment variables"
    } else if (rawMessage.toLowerCase().includes("fetch failed")) {
      message = "Backend request failed due to a network error"
    }

    console.error("pledge/create failed", { requestId, rawMessage })

    return NextResponse.json(
      { error: message, requestId },
      { status: 500, headers: corsHeaders(req) }
    )
  }
}
