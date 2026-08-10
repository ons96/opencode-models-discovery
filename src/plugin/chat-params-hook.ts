import { ToastNotifier } from '../ui/toast-notifier'
import type { PluginConfig } from '../types/plugin-config'

export function createChatParamsHook(_toastNotifier: ToastNotifier, _pluginConfig: PluginConfig) {
  return async (_input: any, _output: any) => {
    // Validation is disabled - only model discovery is enabled
    // Model validation causes false errors for cloud providers
  }
}
