import { NextResponse } from "next/server"
import { getStripe } from "@/src/lib/stripe"
import { getSupabaseAdmin } from "@/src/lib/supabaseAdmin"

export const runtime = "nodejs"

type Body = {
  campaign_id: string
  name: string
  email: string
  rate_per_1000: number
  cap_amount?: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Body>

    if (
      !isNonEmptyString(body.campaign_id) ||
      !isNonEmptyString(body.name) ||
      !isNonEmptyString(body.email)
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    const ratePer1000 = Number(body.rate_per_1000)
    if (!Number.isFinite(ratePer1000) || ratePer1000 < 1) {
      return NextResponse.json(
        { error: "rate_per_1000 must be at least $1" },
        { status: 400 }
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
          { status: 400 }
        )
      }
    }

    const supabaseAdmin = getSupabaseAdmin()

    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("id, views_cap, status")
      .eq("id", body.campaign_id)
      .single()

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    }

    if (campaign.status !== "open") {
      return NextResponse.json(
        { error: "Campaign is not accepting new pledges" },
        { status: 400 }
      )
    }

    const viewsCap =
      Number.isFinite(campaign.views_cap) && campaign.views_cap > 0
        ? Number(campaign.views_cap)
        : 20000

    const ratePer1000Cents = Math.round(ratePer1000 * 100)
    const capAmountCents = capAmount == null ? null : Math.round(capAmount * 100)

    const { data: pledge, error: pledgeError } = await supabaseAdmin
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

    if (pledgeError || !pledge) {
      return NextResponse.json(
        { error: pledgeError?.message ?? "Failed to create pledge" },
        { status: 500 }
      )
    }

    const stripe = getStripe()

    const customer = await stripe.customers.create({
      email: body.email,
      name: body.name,
      metadata: { pledge_id: pledge.id, campaign_id: body.campaign_id },
    })

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customer.id,
      success_url: process.env.SUCCESS_URL as string,
      cancel_url: process.env.CANCEL_URL as string,
      metadata: {
        pledge_id: pledge.id,
        campaign_id: body.campaign_id,
        flow: "pledge_setup",
      },
    })

    await supabaseAdmin
      .from("pledges")
      .update({ stripe_customer_id: customer.id })
      .eq("id", pledge.id)

    return NextResponse.json({ url: session.url }, { status: 200 })
  } catch (e) {
    const message =
      typeof e === "object" && e != null && "message" in e
        ? String((e as { message: unknown }).message)
        : "Request failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
