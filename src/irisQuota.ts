export const irisQuotaFields = [
  { key: 'disk_mib', label: '工作区磁盘（MiB）', step: 1 },
  { key: 'memory_mib', label: '内存上限（MiB）', step: 1 },
  { key: 'cpus', label: 'CPU 核数', step: 0.1 },
  { key: 'pids', label: '最大进程数', step: 1 },
  { key: 'timeout', label: '单条命令时限（秒）', step: 1 },
] as const

export type IrisQuotaKey = typeof irisQuotaFields[number]['key']
export type IrisQuota = Record<IrisQuotaKey, number>
export type IrisQuotaDefaults = {
  quota: IrisQuota
  ranges: Record<IrisQuotaKey, [number, number]>
  total_disk_budget_mib: number
}
