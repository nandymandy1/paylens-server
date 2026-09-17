import dayjs from 'dayjs';
export { dayjs };
export function toUtcIso(value: dayjs.ConfigType): string {
  return dayjs(value).toISOString();
}
