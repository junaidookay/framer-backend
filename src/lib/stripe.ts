import Stripe from "stripe"

let cached: Stripe | null = null

export function getStripe(): Stripe {
  if (cached) return cached
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY")
  cached = new Stripe(key)
  return cached
}
