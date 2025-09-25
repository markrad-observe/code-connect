import { isFetchError, request } from '../common/fetch'
import { logger } from '../common/logging'
import { trace, SpanStatusCode, Span } from '@opentelemetry/api'
import { tracer, logger as otelLogger } from '../otel'
import { SeverityNumber } from '@opentelemetry/api-logs'

const version = require('../../package.json').version

export function getApiUrl(figmaNode: string) {
  return 'https://api.figma.com/v1'
}

export function getHeaders(accessToken: string) {
  return {
    'X-Figma-Token': accessToken,
    'Content-Type': 'application/json',
    'User-Agent': `code-connect-cli/${version}`,
  }
}

// These typings are a subset of the Figma REST API
export namespace FigmaRestApi {
  export enum ComponentPropertyType {
    Boolean = 'BOOLEAN',
    InstanceSwap = 'INSTANCE_SWAP',
    Text = 'TEXT',
    Variant = 'VARIANT',
  }

  export interface ComponentPropertyDefinition {
    defaultValue: boolean | string
    type: ComponentPropertyType
    /**
     * All possible values for this property. Only exists on VARIANT properties
     */
    variantOptions?: string[]
    /**
     * Only exists on INSTANCE_SWAP  properties
     */
    preferredValues?: { type: string; key: string }[]
  }

  export interface Node {
    // we don't care about other node types
    type: 'COMPONENT' | 'COMPONENT_SET' | 'OTHER' | 'CANVAS'
    name: string
    id: string
    children: Node[]
  }

  export interface NodeWithPageInfo extends Node {
    pageId: string
    pageName: string
  }

  export interface Component extends NodeWithPageInfo {
    type: 'COMPONENT' | 'COMPONENT_SET'
    componentPropertyDefinitions: Record<string, ComponentPropertyDefinition>
  }
}

export async function getDocument(url: string, accessToken: string): Promise<FigmaRestApi.Node> {
  return tracer.startActiveSpan('figma.getDocument', async (span: Span) => {
    try {
      span.setAttributes({
        'figma.api.url': url,
        'figma.api.operation': 'getDocument',
      })

      otelLogger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'Fetching component information from Figma',
        attributes: { url },
      })

      logger.info('Fetching component information from Figma...')
      const response = await request.get<{ document: FigmaRestApi.Node }>(url, {
        headers: getHeaders(accessToken),
      })

      span.setAttributes({
        'figma.api.response.status': response.response.status,
      })

      if (response.response.status === 200) {
        logger.info('Successfully fetched component information from Figma')
        span.setStatus({ code: SpanStatusCode.OK })

        otelLogger.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: 'INFO',
          body: 'Successfully fetched component information from Figma',
          attributes: {
            url,
            status: response.response.status,
          },
        })

        return response.data.document
      } else {
        const errorMessage = `Failed to get node information from Figma with status: ${response.response.status}`
        logger.error(errorMessage)
        logger.debug('Failed to get node information from Figma with Body:', response.data)

        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })

        otelLogger.emit({
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          body: errorMessage,
          attributes: {
            url,
            status: response.response.status,
            responseData: JSON.stringify(response.data),
          },
        })

        return Promise.reject()
      }
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
      span.recordException(err as Error)

      if (isFetchError(err)) {
        if (err.response) {
          const errorMessage = `Failed to get node data from Figma (${err.response.status}): ${err.response.status} ${err.data?.err ?? err.data?.message}`
          logger.error(errorMessage)

          otelLogger.emit({
            severityNumber: SeverityNumber.ERROR,
            severityText: 'ERROR',
            body: errorMessage,
            attributes: {
              url,
              status: err.response.status,
              errorData: JSON.stringify(err.data),
            },
          })
        } else {
          logger.error(`Failed to get node data from Figma: ${err.message}`)

          otelLogger.emit({
            severityNumber: SeverityNumber.ERROR,
            severityText: 'ERROR',
            body: 'Failed to get node data from Figma',
            attributes: {
              url,
              error: err.message,
            },
          })
        }
        logger.debug(JSON.stringify(err.data))
      } else {
        logger.error(`Failed to create: ${err}`)

        otelLogger.emit({
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          body: 'Failed to create',
          attributes: {
            url,
            error: String(err),
          },
        })
      }
      return Promise.reject()
    } finally {
      span.end()
    }
  })
}
