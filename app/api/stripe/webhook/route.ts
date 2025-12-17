import { NextResponse } from "next/server"
import { getStripe } from "@/src/lib/stripe"
import { getSupabaseAdmin } from "@/src/lib/supabaseAdmin"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const stripe = getStripe()
  const supabaseAdmin = getSupabaseAdmin()
  const signature = req.headers.get("stripe-signature")
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 })
  }

  const rawBody = await req.text()
  let event
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string
    )
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object
    const metadata = (session as { metadata?: Record<string, string> }).metadata
    const flow = metadata?.flow
    const pledgeId = metadata?.pledge_id

    if (flow === "pledge_setup" && pledgeId) {
      try {
        const setupIntentId = (session as { setup_intent?: string }).setup_intent
        if (!setupIntentId) {
          await supabaseAdmin
            .from("pledges")
            .update({
              setup_status: "failed",
              error_message: "Missing setup_intent on checkout completion",
            })
            .eq("id", pledgeId)
          return NextResponse.json({ received: true })
        }

        const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
        const paymentMethodId =
          typeof setupIntent.payment_method === "string"
            ? setupIntent.payment_method
            : null

        const customerId =
          typeof (session as { customer?: unknown }).customer === "string"
            ? ((session as { customer?: string }).customer as string)
            : null

        if (paymentMethodId && customerId) {
          await supabaseAdmin
            .from("pledges")
            .update({
              stripe_customer_id: customerId,
              stripe_payment_method_id: paymentMethodId,
              setup_status: "complete",
            })
            .eq("id", pledgeId)
        } else {
          await supabaseAdmin
            .from("pledges")
            .update({
              setup_status: "failed",
              error_message: "Missing customer or payment method on setup completion",
            })
            .eq("id", pledgeId)
        }
      } catch (e) {
        const message =
          typeof e === "object" && e != null && "message" in e
            ? String((e as { message: unknown }).message)
            : "Webhook processing failed"

        await supabaseAdmin
          .from("pledges")
          .update({ setup_status: "failed", error_message: message })
          .eq("id", pledgeId)
      }
    }
  }

  return NextResponse.json({ received: true })
}
