export type SettingsSection = 'providers' | 'translate' | 'prompts' | 'proxy' | 'general' | 'data';

export function navigate(hash: string) {
  location.hash = hash;
}

export function openSettings(section: SettingsSection = 'providers') {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: section }));
}
