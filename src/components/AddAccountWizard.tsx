import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { toast } from "sonner"

import { client } from "@/api/client"
import { UI_PROVIDERS, type Provider } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"

type Step = "start" | "wait" | "done"

const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  ghcp: "GitHub Copilot",
}

/** Loopback callback port the gateway uses per provider (DESIGN §4.3). */
const CALLBACK_PORT: Record<Provider, string | undefined> = {
  claude: "54545",
  codex: "1455",
  gemini: undefined,
  ghcp: undefined,
}

const STEP_META: { key: Step; label: string }[] = [
  { key: "start", label: "시작" },
  { key: "wait", label: "인증 대기" },
  { key: "done", label: "완료" },
]

interface CallbackValidation {
  ok: boolean
  /** Blocking reason (submit disabled). */
  reason?: string
  /** Non-blocking warning (submit still allowed). */
  warn?: string
}

/**
 * Client-side validation of the pasted redirect URL before enabling submit.
 * Requires the correct loopback host+port, a `code` param and a `state` param.
 * A state mismatch is a non-blocking warning (the URL may be from another session).
 */
function validateCallback(
  raw: string,
  provider: Provider,
  expectedState: string
): CallbackValidation {
  const value = raw.trim()
  if (!value) return { ok: false }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: "올바른 URL 형식이 아닙니다." }
  }

  const port = CALLBACK_PORT[provider]
  if (!port || url.hostname !== "localhost" || url.port !== port) {
    return {
      ok: false,
      reason: `localhost:${port ?? "?"} 주소의 콜백 URL이어야 합니다.`,
    }
  }

  const code = url.searchParams.get("code")
  if (!code) return { ok: false, reason: "URL에 code 파라미터가 없습니다." }

  const state = url.searchParams.get("state")
  if (!state) return { ok: false, reason: "URL에 state 파라미터가 없습니다." }

  if (expectedState && state !== expectedState) {
    return {
      ok: true,
      warn: "state 값이 처음 발급한 값과 다릅니다. 다른 인증 세션의 URL일 수 있어요.",
    }
  }

  return { ok: true }
}

export interface AddAccountWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once an account is successfully added (parent refreshes lists). */
  onAdded: () => void
}

export function AddAccountWizard({
  open,
  onOpenChange,
  onAdded,
}: AddAccountWizardProps) {
  const [step, setStep] = useState<Step>("start")
  const [provider, setProvider] = useState<Provider>("claude")
  const [nickname, setNickname] = useState("")

  const [authUrl, setAuthUrl] = useState("")
  const [oauthState, setOauthState] = useState<string | null>(null)
  const [callbackUrl, setCallbackUrl] = useState("")

  const [starting, setStarting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)

  // Guards against onAdded firing twice (poll + submit racing to success).
  const completedRef = useRef(false)

  const reset = useCallback(() => {
    setStep("start")
    setProvider("claude")
    setNickname("")
    setAuthUrl("")
    setOauthState(null)
    setCallbackUrl("")
    setStarting(false)
    setSubmitting(false)
    setFlowError(null)
    completedRef.current = false
  }, [])

  const markComplete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    setFlowError(null)
    setStep("done")
    onAdded()
  }, [onAdded])

  // ---- Poll for auto-completion while waiting (2s, DESIGN §6). ----
  useEffect(() => {
    if (step !== "wait" || !oauthState) return
    let active = true
    let timeoutId: number | undefined
    const poll = async () => {
      try {
        const res = await client.getAddStatus(provider, oauthState)
        if (!active) return
        if (res.status === "success") markComplete()
        else if (res.status === "error")
          setFlowError(res.error || "인증 중 오류가 발생했습니다.")
      } catch {
        // Transient poll failure — keep waiting.
      }
      if (active && !completedRef.current) {
        timeoutId = window.setTimeout(poll, 2000)
      }
    }
    timeoutId = window.setTimeout(poll, 2000)
    return () => {
      active = false
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [step, oauthState, provider, markComplete])

  const openAuthTab = useCallback((url: string) => {
    const win = window.open(url, "_blank", "noopener,noreferrer")
    if (!win) {
      toast.warning(
        "새 탭이 차단되었어요. 'URL 다시 열기' 버튼으로 열거나 URL을 복사해 직접 여세요."
      )
    }
  }, [])

  async function handleStart() {
    setStarting(true)
    setFlowError(null)
    try {
      const { url, state } = await client.startAddAccount(
        provider,
        nickname.trim() || undefined
      )
      setAuthUrl(url)
      setOauthState(state)
      setCallbackUrl("")
      completedRef.current = false
      setStep("wait")
      openAuthTab(url)
    } catch (e) {
      setFlowError(
        e instanceof Error ? e.message : "인증 시작에 실패했습니다."
      )
    } finally {
      setStarting(false)
    }
  }

  async function handleSubmit() {
    setSubmitting(true)
    setFlowError(null)
    try {
      const res = await client.submitCallback(provider, callbackUrl.trim())
      if (res.status === "success") markComplete()
      else if (res.status === "error")
        setFlowError(res.error || "콜백 제출에 실패했습니다.")
      else
        toast.info("아직 처리 중입니다. 잠시 후 완료됩니다.")
    } catch (e) {
      setFlowError(
        e instanceof Error ? e.message : "콜백 제출 중 오류가 발생했습니다."
      )
    } finally {
      setSubmitting(false)
    }
  }

  /** Error recovery / expiry (코드 만료): cancel then return to a fresh step 1. */
  async function handleRestart() {
    if (oauthState) {
      try {
        await client.cancelAddAccount(provider)
      } catch {
        // Best-effort — server may have already discarded the state.
      }
    }
    setOauthState(null)
    setAuthUrl("")
    setCallbackUrl("")
    setFlowError(null)
    completedRef.current = false
    setStep("start")
  }

  async function copyAuthUrl() {
    try {
      await navigator.clipboard.writeText(authUrl)
      toast.success("URL을 복사했습니다.")
    } catch {
      toast.error("URL 복사에 실패했습니다.")
    }
  }

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // Closing mid-flow: cancel the in-progress OAuth attempt server-side.
        if (oauthState && step !== "done") {
          client.cancelAddAccount(provider).catch(() => {})
        }
        reset()
      }
      onOpenChange(next)
    },
    [oauthState, step, provider, reset, onOpenChange]
  )

  const validation = useMemo(
    () => validateCallback(callbackUrl, provider, oauthState ?? ""),
    [callbackUrl, provider, oauthState]
  )
  const showValidationHint = callbackUrl.trim().length > 0

  const activeIndex = STEP_META.findIndex((s) => s.key === step)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>계정 추가</DialogTitle>
          <DialogDescription>
            OAuth로 Claude 또는 Codex 계정을 Baton에 연결합니다.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <ol className="flex items-center gap-1.5" aria-label="진행 단계">
          {STEP_META.map((s, i) => {
            const done = i < activeIndex
            const current = i === activeIndex
            return (
              <li key={s.key} className="flex flex-1 items-center gap-1.5">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                    current && "bg-primary text-primary-foreground",
                    done && "bg-primary/20 text-primary",
                    !current && !done && "bg-muted text-muted-foreground"
                  )}
                >
                  {done ? <CheckCircle2 className="size-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium",
                    current ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {s.label}
                </span>
                {i < STEP_META.length - 1 && (
                  <span className="mx-1 h-px flex-1 bg-border" />
                )}
              </li>
            )
          })}
        </ol>

        {/* ---- STEP 1: 시작 ---- */}
        {step === "start" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>제공자</Label>
              <RadioGroup
                value={provider}
                onValueChange={(v) => setProvider(v as Provider)}
                className="grid-cols-2 gap-2"
              >
                {UI_PROVIDERS.map((p) => (
                  <Label
                    key={p}
                    htmlFor={`provider-${p}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border p-3 transition-colors",
                      provider === p
                        ? "border-primary bg-primary/5"
                        : "border-input hover:bg-accent/50"
                    )}
                  >
                    <RadioGroupItem value={p} id={`provider-${p}`} />
                    <span className="text-sm font-medium">
                      {PROVIDER_LABELS[p]}
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="nickname">닉네임 (선택)</Label>
              <Input
                id="nickname"
                placeholder="예: 업무용 계정"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                disabled={starting}
              />
            </div>

            {flowError && (
              <p className="text-sm text-destructive">{flowError}</p>
            )}

            <DialogFooter>
              <Button onClick={handleStart} disabled={starting}>
                {starting ? (
                  <>
                    <Loader2 className="animate-spin" /> 시작 중…
                  </>
                ) : (
                  "인증 시작"
                )}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ---- STEP 2: 인증 대기 ---- */}
        {step === "wait" && (
          <div className="flex flex-col gap-4">
            {flowError ? (
              <div className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium text-destructive">
                      인증에 실패했습니다
                    </p>
                    <p className="text-sm text-muted-foreground">{flowError}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  코드가 만료되었거나 URL이 잘못되었을 수 있어요. 새 인증을
                  시작하세요.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                새 탭의 브라우저에서 로그인·승인하세요 (CAPTCHA가 있을 수
                있습니다). 리다이렉트가 'localhost 연결 실패' 페이지로 끝나면 그
                주소창의 전체 URL을 복사해 아래에 붙여넣으세요.
              </p>
            )}

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => openAuthTab(authUrl)}
                disabled={!authUrl}
              >
                <ExternalLink /> URL 다시 열기
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={copyAuthUrl}
                disabled={!authUrl}
              >
                <Copy /> URL 복사
              </Button>
            </div>

            {!flowError && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="callback-url">콜백 URL</Label>
                <Input
                  id="callback-url"
                  placeholder="http://localhost:… 붙여넣기"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  aria-invalid={showValidationHint && !validation.ok}
                  autoComplete="off"
                  spellCheck={false}
                />
                {showValidationHint && validation.reason && (
                  <p className="text-xs text-destructive">
                    {validation.reason}
                  </p>
                )}
                {validation.warn && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                    <AlertTriangle className="size-3.5" /> {validation.warn}
                  </p>
                )}
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> 완료를 자동으로
                  확인하는 중…
                </p>
              </div>
            )}

            <DialogFooter className="sm:justify-between">
              {flowError ? (
                <Button variant="outline" onClick={handleRestart}>
                  <RefreshCw /> 다시 시작
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    onClick={handleRestart}
                    className="text-muted-foreground"
                  >
                    다시 시작
                  </Button>
                  <Button
                    onClick={handleSubmit}
                    disabled={!validation.ok || submitting}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="animate-spin" /> 제출 중…
                      </>
                    ) : (
                      "완료"
                    )}
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        )}

        {/* ---- STEP 3: 완료 ---- */}
        {step === "done" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-green-500/15">
              <CheckCircle2 className="size-7 text-green-600 dark:text-green-500" />
            </div>
            <p className="text-base font-medium">계정이 추가되었습니다</p>
            <p className="text-sm text-muted-foreground">
              {PROVIDER_LABELS[provider]} 계정이 로테이션에 등록되었습니다.
            </p>
            <DialogFooter className="w-full sm:justify-center">
              <Button onClick={() => handleOpenChange(false)}>닫기</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default AddAccountWizard
