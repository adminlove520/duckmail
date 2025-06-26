import { type NextRequest, NextResponse } from "next/server"

// 默认API提供商（向后兼容）
const DEFAULT_API_BASE_URL = "https://duckmail.sbs"

// 从请求头获取API提供商的基础URL
function getApiBaseUrl(request: NextRequest): string {
  const providerBaseUrl = request.headers.get("X-API-Provider-Base-URL")
  return providerBaseUrl || DEFAULT_API_BASE_URL
}

async function handleRequest(
  originalRequest: NextRequest,
  endpoint: string,
  options: RequestInit,
) {
  const apiBaseUrl = getApiBaseUrl(originalRequest)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000) // 15秒超时

  const requestHeaders = new Headers(options.headers)

  // 针对所有请求，设置更通用的 Accept header，优先 ld+json
  requestHeaders.set("Accept", "application/ld+json, application/json, */*")

  if (options.method === "GET" || !options.method) {
    // GET 请求通常不需要 Content-Type
    requestHeaders.delete("Content-Type")
  }

  // 确保 User-Agent 存在
  if (!requestHeaders.has("User-Agent")) {
    requestHeaders.set("User-Agent", "DuckMail/1.0 (Vercel Function)")
  }

  const finalOptions: RequestInit = {
    ...options,
    headers: requestHeaders,
    signal: controller.signal,
  }

  console.log(
    `Proxying request to: ${apiBaseUrl}${endpoint}`,
    `Method: ${finalOptions.method || "GET"}`,
    `Headers: ${JSON.stringify(Object.fromEntries(requestHeaders.entries()))}`,
  )
  if (finalOptions.body) {
    console.log(`Body: ${finalOptions.body}`)
  }

  try {
    const response = await fetch(`${apiBaseUrl}${endpoint}`, finalOptions)
    clearTimeout(timeoutId)

    const responseContentType = response.headers.get("Content-Type") || "unknown"
    console.log(
      `Response from DuckMail API for ${endpoint}: Status ${response.status}, Content-Type: ${responseContentType}`,
    )

    if (!response.ok) {
      const errorBody = await response.text()
      console.error(
        `API Error for ${endpoint}: ${response.status} ${response.statusText}`,
        `Response body: ${errorBody}`,
      )
      return new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": responseContentType },
      })
    }

    if (response.status === 204) {
      // No Content
      return new Response(null, { status: 204 })
    }

    // 尝试解析 JSON，即使 Content-Type 不是严格的 application/json
    // mail.tm 使用 application/ld+json
    if (responseContentType.includes("json") || responseContentType.includes("javascript")) {
      try {
        const data = await response.json()
        return NextResponse.json(data)
      } catch (jsonError: any) {
        console.error(
          `Error parsing JSON response from ${endpoint} (Content-Type: ${responseContentType}):`,
          jsonError.message,
        )
        // 如果 JSON 解析失败，尝试返回文本
        const textDataFallback = await response.text() // Re-read as text if original read failed or was not text
        console.error(`Response text fallback: ${textDataFallback.substring(0, 200)}`)
        return NextResponse.json(
          {
            error: "Failed to parse JSON response from upstream API",
            details: jsonError.message,
            upstream_status: response.status,
            upstream_content_type: responseContentType,
          },
          { status: 502 }, // Bad Gateway
        )
      }
    } else {
      const textData = await response.text()
      console.warn(
        `Received non-JSON response from ${endpoint}: ${responseContentType}. Body: ${textData.substring(0, 100)}...`,
      )
      return new Response(textData, {
        status: response.status,
        headers: { "Content-Type": responseContentType },
      })
    }
  } catch (error: any) {
    clearTimeout(timeoutId)
    if (error.name === "AbortError") {
      console.error(`API request to ${endpoint} timed out:`, error.message)
      return NextResponse.json(
        {
          error: `Failed to fetch from API: Request to ${endpoint} timed out`,
          details: error.message,
        },
        { status: 504 }, // Gateway Timeout
      )
    }
    console.error(`API Proxy Error for ${endpoint}:`, error.message, error.stack)
    return NextResponse.json(
      {
        error: `Failed to fetch from API for ${endpoint}`,
        details: error.message,
      },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || ""
  const authHeader = request.headers.get("Authorization")

  const headersInit: HeadersInit = {}
  if (authHeader) {
    headersInit["Authorization"] = authHeader
  }
  // User-Agent 和 Accept 会在 handleRequest 中设置

  return handleRequest(request, endpoint, { headers: headersInit, method: "GET" })
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || ""
  const authHeader = request.headers.get("Authorization")
  let body
  try {
    body = await request.json()
  } catch (e) {
    console.error("Error parsing POST request body:", e)
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const headersInit: HeadersInit = {
    "Content-Type": "application/json", // POST 请求需要 Content-Type
  }
  if (authHeader) {
    headersInit["Authorization"] = authHeader
  }
  // User-Agent 和 Accept 会在 handleRequest 中设置

  return handleRequest(request, endpoint, {
    method: "POST",
    headers: headersInit,
    body: JSON.stringify(body),
  })
}

export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || ""
  const authHeader = request.headers.get("Authorization")

  let body
  try {
    body = await request.json()
  } catch (e) {
    console.error("Error parsing PATCH request body:", e)
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const headersInit: HeadersInit = {
    "Content-Type": "application/merge-patch+json", // mail.tm PATCH 需要这个
  }
  if (authHeader) {
    headersInit["Authorization"] = authHeader
  }
  // User-Agent 和 Accept 会在 handleRequest 中设置

  return handleRequest(request, endpoint, {
    method: "PATCH",
    headers: headersInit,
    body: JSON.stringify(body),
  })
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const endpoint = searchParams.get("endpoint") || ""
  const authHeader = request.headers.get("Authorization")

  const headersInit: HeadersInit = {}
  if (authHeader) {
    headersInit["Authorization"] = authHeader
  }
  // User-Agent 和 Accept 会在 handleRequest 中设置

  return handleRequest(request, endpoint, { method: "DELETE", headers: headersInit })
}
