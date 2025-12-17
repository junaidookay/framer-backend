import { NextResponse } from "next/server"
import { getStripe } from "@/src/lib/stripe"
import { getSupabaseAdmin } from "@/src/lib/supabaseAdmin"

export const runtime = "nodejs"

type Body = {
  password: string
  campaign_id: string
}

function computeAmountCents(params: {
  finalViews: number
  viewsCap: number
  ratePer1000Cents: number
  donorCapCents: number | null
}): { computedViews: number; amountCents: number } {
  const countedViews = Math.min(params.finalViews, params.viewsCap)
  const units = Math.floor(countedViews / 1000)
  let amount = units * params.ratePer1000Cents

  if (params.donorCapCents != null) {
    amount = Math.min(amount, params.donorCapCents)
  }

  if (amount > 0 && amount < 100) amount = 100

  return { computedViews: countedViews, amountCents: amount }
}

export async function POST(req: Request) {
  try {
    const stripe = getStripe()
    const supabaseAdmin = getSupabaseAdmin()
    const body = (await req.json()) as Partial<Body>
    if (body.password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : ""
    if (!campaignId) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 })
    }

    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("id, name, views_cap, final_views")
      .eq("id", campaignId)
      .single()

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    }

    if (campaign.final_views == null) {
      return NextResponse.json(
        { error: "final_views not set yet" },
        { status: 400 }
      )
    }

    const finalViews = Number(campaign.final_views)
    const viewsCap =
      Number.isFinite(campaign.views_cap) && Number(campaign.views_cap) > 0
        ? Number(campaign.views_cap)
        : 20000

    const { data: pledges, error: pledgesError } = await supabaseAdmin
      .from("pledges")
      .select(
        "id, rate_per_1000_cents, cap_amount_cents, stripe_customer_id, stripe_payment_method_id"
      )
      .eq("campaign_id", campaignId)
      .eq("setup_status", "complete")
      .eq("charge_status", "not_charged")

    if (pledgesError) {
      return NextResponse.json({ error: pledgesError.message }, { status: 500 })
    }

    let charged = 0
    let skipped = 0
    let failed = 0
    let requiresAction = 0

    for (const pledge of pledges ?? []) {
      const pledgeId = pledge.id as string
      try {
        const { computedViews, amountCents } = computeAmountCents({
          finalViews,
          viewsCap,
          ratePer1000Cents: Number(pledge.rate_per_1000_cents),
          donorCapCents:
            pledge.cap_amount_cents == null ? null : Number(pledge.cap_amount_cents),
        })

        await supabaseAdmin
          .from("pledges")
          .update({
            computed_views: computedViews,
            computed_amount_cents: amountCents,
          })
          .eq("id", pledgeId)

        if (amountCents <= 0) {
          skipped++
          await supabaseAdmin
            .from("pledges")
            .update({ charge_status: "skipped" })
            .eq("id", pledgeId)
          continue
        }

        const customerId = pledge.stripe_customer_id as string | null
        const paymentMethodId = pledge.stripe_payment_method_id as string | null
        if (!customerId || !paymentMethodId) {
          failed++
          await supabaseAdmin
            .from("pledges")
            .update({
              charge_status: "failed",
              error_message: "Missing Stripe customer or payment method",
            })
            .eq("id", pledgeId)
          continue
        }

        const pi = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "usd",
          customer: customerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          description: `Donation pledge charge (${campaign.name ?? "Campaign"})`,
          metadata: {
            pledge_id: pledgeId,
            campaign_id: campaignId,
            computed_views: String(computedViews),
          },
        })

        charged++
        await supabaseAdmin
          .from("pledges")
          .update({
            charge_status: "charged",
            stripe_payment_intent_id: pi.id,
            error_message: null,
          })
          .eq("id", pledgeId)
      } catch (e) {
        const err = e as {
          message?: string
          code?: string
          payment_intent?: { id?: string; status?: string }
        }

        const message = err?.message ?? "Charge failed"
        const paymentIntentId = err?.payment_intent?.id ?? null
        const needsAction =
          err?.code === "authentication_required" ||
          err?.payment_intent?.status === "requires_action"

        if (needsAction) {
          requiresAction++
          await supabaseAdmin
            .from("pledges")
            .update({
              charge_status: "requires_action",
              error_message: message,
              stripe_payment_intent_id: paymentIntentId,
            })
            .eq("id", pledgeId)
        } else {
          failed++
          await supabaseAdmin
            .from("pledges")
            .update({
              charge_status: "failed",
              error_message: message,
              stripe_payment_intent_id: paymentIntentId,
            })
            .eq("id", pledgeId)
        }
      }
    }

    await supabaseAdmin
      .from("campaigns")
      .update({ status: "charged" })
      .eq("id", campaignId)

    return NextResponse.json(
      { ok: true, charged, skipped, failed, requiresAction },
      { status: 200 }
    )
  } catch {
    return NextResponse.json({ error: "Request failed" }, { status: 500 })
  }
}
