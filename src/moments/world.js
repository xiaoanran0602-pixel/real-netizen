// ============================================================
// 外部世界：她所在城市的天气、最近的新闻标题。缓存 30 分钟，写在 data/world.json。
// 数据源都是免 key 的公开接口：open-meteo（天气/地理编码）、中新网滚动新闻 RSS。
// ============================================================

import { paths } from "../config/paths.js";
import { readJson, writeJsonAtomic } from "../store/files.js";

const CACHE_TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const NEWS_LIMIT = 12;
const NEWS_FEED = "https://www.chinanews.com.cn/rss/scroll-news.xml";
export const DEFAULT_CITY = "上海";

/** WMO 天气代码 → 中文。 */
export function describeWeatherCode(code) {
  if (code === 0) return "晴";
  if (code <= 2) return "晴间多云";
  if (code === 3) return "阴";
  if (code <= 48) return "有雾";
  if (code <= 57) return "毛毛雨";
  if (code <= 67) return "下雨";
  if (code <= 77) return "下雪";
  if (code <= 82) return "阵雨";
  if (code <= 86) return "阵雪";
  return "雷雨";
}

export function weatherKind(code) {
  if (code <= 2) return "clear";
  if (code <= 48) return "cloudy";
  if (code <= 67 || (code >= 80 && code <= 82)) return "rain";
  if (code <= 86) return "snow";
  return "storm";
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchWeather(city) {
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`);
  const place = geo.results?.[0];
  if (!place) return undefined;
  const data = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&timezone=${encodeURIComponent(place.timezone ?? "auto")}&forecast_days=2`,
  );
  if (!data.current) return undefined;
  const tomorrowCode = data.daily?.weather_code?.[1];
  return {
    city,
    temperature: Math.round(data.current.temperature_2m),
    code: data.current.weather_code,
    description: describeWeatherCode(data.current.weather_code),
    ...(data.daily ? { todayMax: Math.round(data.daily.temperature_2m_max[0]), todayMin: Math.round(data.daily.temperature_2m_min[0]) } : {}),
    ...(tomorrowCode !== undefined ? { tomorrowDescription: describeWeatherCode(tomorrowCode) } : {}),
  };
}

async function fetchNews() {
  const response = await fetch(NEWS_FEED, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return [];
  const xml = await response.text();
  return [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gu)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, NEWS_LIMIT);
}

/** 读世界状态；缓存过期或城市变了就刷新。刷新失败时保留旧缓存。 */
export async function getWorld(city, force = false) {
  const cached = await readJson(paths.world(), { fetchedAt: 0, city, news: [] });
  const fresh = cached.city === city && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return cached;
  const [weather, news] = await Promise.all([fetchWeather(city).catch(() => undefined), fetchNews().catch(() => [])]);
  const keptWeather = weather ?? (cached.city === city ? cached.weather : undefined);
  // 修复（docs/14 第 4.3 节）：原来失败保留旧天气时也刷新 fetchedAt，旧天气就被伪装成刚观测的。
  // weatherObservedAt 只在拿到新的有效天气时更新；保留旧天气时沿用旧的观测时间（旧缓存没有就是未知）。
  const weatherObservedAt = weather ? Date.now() : cached.city === city ? cached.weatherObservedAt : undefined;
  const next = {
    fetchedAt: Date.now(),
    city,
    ...(keptWeather ? { weather: keptWeather } : {}),
    ...(weatherObservedAt ? { weatherObservedAt } : {}),
    news: news.length > 0 ? news : cached.news ?? [],
    ...(cached.weather ? { previousWeatherKind: weatherKind(cached.weather.code) } : {}),
  };
  await writeJsonAtomic(paths.world(), next);
  return next;
}

export function formatWeather(weather) {
  if (!weather) return "";
  const range = weather.todayMin !== undefined && weather.todayMax !== undefined ? `，今天 ${weather.todayMin}–${weather.todayMax}°C` : "";
  const tomorrow = weather.tomorrowDescription ? `，明天${weather.tomorrowDescription}` : "";
  return `${weather.city}现在${weather.description}，${weather.temperature}°C${range}${tomorrow}`;
}
