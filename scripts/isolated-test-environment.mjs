import { randomUUID } from 'node:crypto'
import path from 'node:path'

export function isolatedEnvironment(directory, port, source = process.env) {
  const env = Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith('BATON_')),
  )
  const home = path.join(directory, 'home')
  const localAppData = path.join(directory, 'local-app-data')
  const recoveryRoot = path.join(directory, 'recovery')
  return {
    ...env,
    NODE_ENV: 'test',
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    APPDATA: path.join(directory, 'app-data'),
    XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
    BATON_DISABLE_ENV_FILE: '1',
    BATON_DATA_DIR: path.join(directory, 'data'),
    BATON_PORT: String(port),
    BATON_URL: `http://127.0.0.1:${port}`,
    BATON_TASK_NAME: `Baton-Test-Isolated-${randomUUID()}`,
    BATON_RELEASE_ROOT: path.join(directory, 'release-root'),
    BATON_RECOVERY_ROOT: recoveryRoot,
    BATON_BOOTSTRAP_ROOT: path.join(directory, 'bootstrap'),
    BATON_OFFLINE_HOME: home,
    BATON_OFFLINE_LOCAL_APP_DATA: localAppData,
    BATON_WORKER_EXECUTABLE: process.execPath,
  }
}
