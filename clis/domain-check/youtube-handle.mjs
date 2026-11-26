const channelsEndpoint = 'https://www.googleapis.com/youtube/v3/channels';

export const validYouTubeHandle = handle => handle.length >= 3 && handle.length <= 30;

export function youtubeHandleUrl(handle) {
  return channelsEndpoint + '?' + new URLSearchParams({ part: 'id', forHandle: '@' + handle });
}

export function classifyYouTubeHandle(status, data) {
  const errors = data?.error?.errors;
  if (status === 404 && Array.isArray(errors) && errors.some(error => error?.reason === 'channelNotFound')) {
    return 'not-found';
  }
  if (status !== 200 || !Array.isArray(data?.items) || data.error) return 'unknown';
  if (data.items.length === 0) return 'not-found';
  const id = data.items[0]?.id;
  return data.items.length === 1 && typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id) ? 'taken' : 'unknown';
}
