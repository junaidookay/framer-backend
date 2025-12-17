import { NextResponse } from "next/server"
import { getSupabaseAdmin } from "@/src/lib/supabaseAdmin"

export const runtime = "nodejs"

type Body = {
  password: string
  campaign_id: string
  final_views: number
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Body>
    if (body.password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : ""
    const finalViews = Number(body.final_views)

    if (!campaignId || !Number.isFinite(finalViews) || finalViews < 0) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 })
    }

    const supabaseAdmin = getSupabaseAdmin()

    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("id, status")
      .eq("id", campaignId)
      .single()

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    }

    if (campaign.status === "charged") {
      return NextResponse.json(
        { error: "Campaign is already charged" },
        { status: 400 }
      )
    }

    const { error } = await supabaseAdmin
      .from("campaigns")
      .update({
        final_views: Math.floor(finalViews),
        status: "locked",
      })
      .eq("id", campaignId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (e) {
    const message =
      typeof e === "object" && e != null && "message" in e
        ? String((e as { message: unknown }).message)
        : "Request failed"

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
