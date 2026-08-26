export function hasEnvironmentProxy(environment = process.env) {
  const values = [
    environment.https_proxy ?? environment.HTTPS_PROXY,
    environment.http_proxy ?? environment.HTTP_PROXY,
  ]
  return values.some(value => typeof value === 'string' && value.trim().length > 0)
}

/** Install an undici dispatcher that honors the standard proxy environment. */
export async function installEnvironmentProxy(
  environment = process.env,
  loadUndici = () => import('undici'),
) {
  if (!hasEnvironmentProxy(environment)) return undefined

  const { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = await loadUndici()
  const previous = getGlobalDispatcher()
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY
  const noProxy = environment.no_proxy ?? environment.NO_PROXY
  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  })
  setGlobalDispatcher(dispatcher)

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    setGlobalDispatcher(previous)
    await dispatcher.close()
  }
}
