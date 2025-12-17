import { NextResponse } from "next/server"
import { getStripe } from "@/src/lib/stripe"

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
        { status: 400, headers: corsHeaders(req) }
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

    return NextResponse.json(
      { url: session.url },
      { status: 200, headers: corsHeaders(req) }
    )
  } catch {
    return NextResponse.json(
      { error: "Unable to create checkout session" },
      { status: 500, headers: corsHeaders(req) }
    )
  }
}
