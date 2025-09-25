
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import { trace, SpanStatusCode, Span } from '@opentelemetry/api'
import { tracer, httpRequestCounter, httpRequestDuration } from '../otel'

type Method = 'POST' | 'GET' | 'PUT' | 'DELETE' | 'post' | 'get' | 'put' | 'delete'

type Options<OptionsT extends RequestInit = RequestInit> = OptionsT & {
  /* Set the query string of the request from an object */
  query?: Record<string, any>
}

class FetchError extends Error {
  constructor(
    public response: Response,
    public data: Record<any, any> | undefined,
  ) {
    super()
  }
}

export const isFetchError = (error: unknown): error is FetchError => {
  return error instanceof FetchError
}

export function getProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  )
}

/**
 * Creates a ProxyAgent and sets it as the global dispatcher via unidici (which
 * affects fetch calls) if a proxy is set either in VS Code settings or as an
 * environment variable.
 */
const proxyUrl = getProxyUrl()
const agent = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined
if (agent) {
  setGlobalDispatcher(agent)
}

/**
 * Makes a request to the Figma API. This is used by other functions to make
 * various types of requests. We return both the response object, and the data
 * parsed as JSON, to make it easier to work with the response.
 */
async function makeRequestInternal<ResponseT = unknown>(
  url: string,
  method: Method,
  options: Options = {},
  body?: Record<any, any>,
) {
  return tracer.startActiveSpan('http.request', async (span: Span) => {
    const startTime = Date.now()

    try {
      const urlObj = new URL(url)
      if (options?.query) {
        Object.entries(options.query).forEach(([key, value]) => {
          urlObj.searchParams.append(key, value as string)
        })
      }
      url = urlObj.toString()

      span.setAttributes({
        'http.method': method,
        'http.url': url,
        'http.scheme': urlObj.protocol.slice(0, -1),
        'http.host': urlObj.host,
        'http.target': urlObj.pathname + urlObj.search,
      })

      if (body) {
        options.body = JSON.stringify(body)
        span.setAttributes({
          'http.request.body.size': options.body.length,
        })
      }

      const response = await fetch(url, { ...options, method })

      span.setAttributes({
        'http.status_code': response.status,
        'http.status_text': response.statusText,
      })

      if (!response.ok) {
        let data
        try {
          data = await response.json()
        } catch (e) {
          data = undefined
        }

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${response.status}: ${response.statusText}`
        })

        throw new FetchError(response, data)
      }

      const text = await response.text()
      const data = text ? (JSON.parse(text) as ResponseT) : ({} as ResponseT)

      span.setAttributes({
        'http.response.body.size': text.length,
      })

      span.setStatus({ code: SpanStatusCode.OK })

      const duration = (Date.now() - startTime) / 1000
      httpRequestCounter.add(1, {
        method,
        status: response.status.toString(),
        host: urlObj.host,
      })
      httpRequestDuration.record(duration, {
        method,
        status: response.status.toString(),
        host: urlObj.host,
      })

      return { response, data }
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000
      const status = error instanceof FetchError ? error.response.status.toString() : 'error'
      const urlObj = new URL(url)

      httpRequestCounter.add(1, {
        method,
        status,
        host: urlObj.host,
      })
      httpRequestDuration.record(duration, {
        method,
        status,
        host: urlObj.host,
      })

      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
      span.recordException(error as Error)
      throw error
    } finally {
      span.end()
    }
  })
}

export const request = {
  get: <MetaT>(url: string, options: Options = {}) => {
    return makeRequestInternal<MetaT>(url, 'GET', options)
  },
  post: <MetaT>(url: string, body: Record<any, any>, options: Options = {}) => {
    return makeRequestInternal<MetaT>(url, 'POST', options, body)
  },
  put: <MetaT>(url: string, body: Record<any, any>, options: Options = {}) => {
    return makeRequestInternal<MetaT>(url, 'PUT', options, body)
  },
  delete: <MetaT>(url: string, body?: Record<any, any>, options: Options = {}) => {
    return makeRequestInternal<MetaT>(url, 'DELETE', options, body)
  },
}
