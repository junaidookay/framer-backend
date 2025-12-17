import { NextResponse } from "next/server"
import { getStripe } from "@/src/lib/stripe"

export const runtime = "nodejs"

type Body = {
  amount: number
  name?: string
  email?: string
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Body>
    const amount = Number(body.amount)

    if (!Number.isFinite(amount) || amount < 1) {
      return NextResponse.json(
        { error: "Minimum donation is $1" },
        { status: 400 }
      )
    }

    const amountCents = Math.round(amount * 100)

    const stripe = getStripe()

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: process.env.SUCCESS_URL as string,
      cancel_url: process.env.CANCEL_URL as string,
      customer_email: typeof body.email === "string" ? body.email : undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation" },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      metadata: { flow: "donate_now" },
    })

    return NextResponse.json({ url: session.url }, { status: 200 })
  } catch (e) {
    const message =
      typeof e === "object" && e != null && "message" in e
        ? String((e as { message: unknown }).message)
        : "Request failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
