import { NextRequest, NextResponse } from "next/server";

/**
 * What is actually left in the DeepSeek account.
 *
 * Everything else in this app estimates cost from token counts after a reply
 * has finished. That is useful for comparing one reply to another and useless
 * for the question that matters — can the next one even run.
 *
 * The gap is not academic. DeepSeek bills post-paid: a request is admitted
 * against the balance *before* it runs and deducted after, so a single
 * forty-round agent task can start with four cents available and end tens of
 * cents overdrawn. Nothing stops mid-request because it turned out expensive.
 * The only way to see that coming is to ask the account, which is what this
 * does.
 */

const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

export interface BalanceResult {
  /** DeepSeek's own verdict on whether calls will be accepted. */
  available: boolean;
  /** Total balance, granted plus topped up. */
  total: number;
  currency: string;
  /** Set when the balance could not be read; the UI stays quiet rather than guessing. */
  error?: string;
}

export async function POST(req: NextRequest) {
  let body: { deepseekApiKey?: unknown };
  try {
    body = (await req.json()) as { deepseekApiKey?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey =
    typeof body.deepseekApiKey === "string" ? body.deepseekApiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "No API key" }, { status: 400 });
  }

  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // Short: this runs alongside real work and must never hold anything up.
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]),
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            res.status === 401
              ? "Your DeepSeek key was rejected."
              : `Couldn't read the balance (${res.status}).`,
        },
        { status: 200 } // Reported in the payload, not as a failed request.
      );
    }

    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: {
        currency?: string;
        total_balance?: string;
      }[];
    };

    /*
     * Prefer USD when the account reports several currencies.
     *
     * `balance_infos` is an array and may hold both CNY and USD. Picking the
     * first entry blindly would show a number in the wrong currency, which is
     * worse than showing nothing — the whole point is a figure you can trust
     * at a glance.
     */
    const infos = data.balance_infos ?? [];
    const chosen = infos.find((i) => i.currency === "USD") ?? infos[0];

    const result: BalanceResult = {
      available: data.is_available === true,
      total: Number(chosen?.total_balance ?? "0"),
      currency: chosen?.currency ?? "USD",
    };

    return NextResponse.json(result);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "Balance check timed out."
          : "Couldn't reach DeepSeek to check the balance.",
      },
      { status: 200 }
    );
  }
}
