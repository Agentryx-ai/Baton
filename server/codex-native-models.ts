import type { CodexNativeCredential } from './codex-native-credentials.ts'

export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

interface CodexRemoteModel {
  slug?: unknown
  [key: string]: unknown
}

interface CodexModelsResponse {
  models?: unknown
}

export interface CodexModelCatalogOptions {
  modelsUrl?: string
  clientVersion: string
  fetchImpl?: typeof fetch
}

export interface CodexAccountModels {
  accountId: string
  models: string[]
  fetchedAt: string
  plan?: string
}

export class CodexModelCatalogError extends Error {
  readonly code: 'authentication' | 'rate_limit' | 'upstream' | 'invalid'

  constructor(code: CodexModelCatalogError['code'], message: string) {
    super(message)
    this.name = 'CodexModelCatalogError'
    this.code = code
  }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

export class CodexModelCatalog {
  private readonly modelsUrl: string
  private readonly clientVersion: string
  private readonly fetchImpl: typeof fetch
  private readonly byAccount = new Map<string, CodexAccountModels>()

  constructor(options: CodexModelCatalogOptions) {
    this.modelsUrl = options.modelsUrl ?? CODEX_MODELS_URL
    this.clientVersion = options.clientVersion
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async refresh(credential: CodexNativeCredential): Promise<CodexAccountModels> {
    const url = new URL(this.modelsUrl)
    url.searchParams.set('client_version', this.clientVersion)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          ...(credential.chatgptAccountId
            ? { 'chatgpt-account-id': credential.chatgptAccountId }
            : {}),
          accept: 'application/json',
          originator: 'baton',
        },
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new CodexModelCatalogError('upstream', 'Codex 모델 카탈로그 endpoint에 연결하지 못했습니다.')
    }
    if (response.status === 401 || response.status === 403) {
      throw new CodexModelCatalogError('authentication', 'Codex 모델 카탈로그 인증에 실패했습니다.')
    }
    if (response.status === 429) {
      throw new CodexModelCatalogError('rate_limit', 'Codex 모델 카탈로그 요청 한도를 초과했습니다.')
    }
    if (!response.ok) {
      throw new CodexModelCatalogError('upstream', `Codex 모델 카탈로그가 HTTP ${response.status}를 반환했습니다.`)
    }
    let body: CodexModelsResponse
    try {
      body = await response.json() as CodexModelsResponse
    } catch {
      throw new CodexModelCatalogError('invalid', 'Codex 모델 카탈로그가 올바른 JSON이 아닙니다.')
    }
    if (!Array.isArray(body.models)) {
      throw new CodexModelCatalogError('invalid', 'Codex 모델 카탈로그에 models 배열이 없습니다.')
    }
    const models = Array.from(new Set(
      (body.models as CodexRemoteModel[])
        .map((model) => model?.slug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0),
    )).sort(compareText)
    const result: CodexAccountModels = {
      accountId: credential.accountId,
      models,
      fetchedAt: new Date().toISOString(),
      ...(credential.plan ? { plan: credential.plan } : {}),
    }
    this.byAccount.set(credential.accountId, result)
    return structuredClone(result)
  }

  get(accountId: string): CodexAccountModels | undefined {
    const result = this.byAccount.get(accountId)
    return result ? structuredClone(result) : undefined
  }

  supports(accountId: string, model: string): boolean {
    return this.byAccount.get(accountId)?.models.includes(model) ?? false
  }

  allModels(activeAccountIds?: ReadonlySet<string>): string[] {
    const models = new Set<string>()
    for (const [accountId, catalog] of this.byAccount) {
      if (activeAccountIds && !activeAccountIds.has(accountId)) continue
      for (const model of catalog.models) models.add(model)
    }
    return Array.from(models).sort(compareText)
  }

  remove(accountId: string): void {
    this.byAccount.delete(accountId)
  }
}
