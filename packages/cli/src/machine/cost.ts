/**
 * Cost estimates from published list prices, read on 2026-11-09. Estimates, not bills: the cloud's
 * billing page is the final word. Prices exclude VAT.
 *
 * Google Cloud (https://cloud.google.com/compute/vm-instance-pricing): N2 on demand in us-central1,
 * USD 0.031611 per vCPU-hour and 0.004237 per GB-hour of memory (europe-west1 about 10 % more); a
 * pd-balanced disk USD 0.10 per GB-month; an in-use external IPv4 address USD 0.005 per hour.
 * Scaleway (https://www.scaleway.com/en/pricing/apple-silicon/): Mac mini per hour, billed from
 * creation until deletion with a 24-hour minimum, also while powered off.
 */
export const GCP_VCPU_HOUR = 0.031611;
export const GCP_GB_HOUR = 0.004237;
export const GCP_DISK_GB_MONTH = 0.1;
export const GCP_IP_HOUR = 0.005;
const HOURS_PER_MONTH = 730;

export const SCALEWAY_HOURLY_EUR: Record<string, number> = {
  "M1-M": 0.11,
  "M2-M": 0.17,
  "M2-L": 0.21,
  "M4-S": 0.22,
  "M4-SP": 0.24,
  "M4-M": 0.29,
  "M4-XL": 0.49,
};

/** vCPUs and GB of memory of the N2 shapes `machine create` offers. */
const N2_SHAPES: Record<string, [number, number]> = {
  "n2-standard-2": [2, 8],
  "n2-standard-4": [4, 16],
  "n2-standard-8": [8, 32],
  "n2-standard-16": [16, 64],
};

export function gcpShape(machineType: string): [number, number] | undefined {
  return N2_SHAPES[machineType];
}

/** USD per hour while the VM runs (vCPU, memory, external IP), without the disk. */
export function gcpRunningHourly(machineType: string): number | undefined {
  const shape = N2_SHAPES[machineType];
  if (!shape) return undefined;
  return shape[0] * GCP_VCPU_HOUR + shape[1] * GCP_GB_HOUR + GCP_IP_HOUR;
}

/** USD per hour for the disk, whether the VM runs or is stopped. */
export function gcpDiskHourly(diskGb: number): number {
  return (diskGb * GCP_DISK_GB_MONTH) / HOURS_PER_MONTH;
}

export interface CostEstimate {
  /** Rate now, per hour. */
  hourly: number;
  /** Estimated so far. */
  soFar: number;
  currency: "USD" | "EUR";
  /** How the estimate was made, for the person reading it. */
  basis: string;
}

/**
 * Google Cloud: the disk for the whole age, plus running time. Compute Engine reports only the current
 * run's start, so earlier runs are not known: the estimate is an upper bound that counts the whole age
 * as running, unless the VM never stopped (then it is exact up to list prices).
 */
export function gcpCost(input: { machineType: string; diskGb: number; createdAt: Date; status: string; now: Date }): CostEstimate | undefined {
  const run = gcpRunningHourly(input.machineType);
  if (run === undefined) return undefined;
  const hours = Math.max(0, (input.now.getTime() - input.createdAt.getTime()) / 3_600_000);
  const disk = gcpDiskHourly(input.diskGb);
  const running = input.status === "RUNNING" || input.status === "PROVISIONING" || input.status === "STAGING";
  return {
    hourly: (running ? run : 0) + disk,
    soFar: hours * (run + disk),
    currency: "USD",
    basis: "at most: counts the whole age as running time (earlier stops are not known), plus the disk",
  };
}

/** Scaleway: hourly from creation until deletion, at least 24 hours. */
export function scalewayCost(input: { type: string; createdAt: Date; now: Date }): CostEstimate | undefined {
  const rate = SCALEWAY_HOURLY_EUR[input.type];
  if (rate === undefined) return undefined;
  const hours = Math.max(24, (input.now.getTime() - input.createdAt.getTime()) / 3_600_000);
  return { hourly: rate, soFar: hours * rate, currency: "EUR", basis: "billed from creation until deletion, at least 24 hours, excluding VAT" };
}

export function money(amount: number, currency: "USD" | "EUR"): string {
  return `${currency === "USD" ? "USD" : "EUR"} ${amount < 10 ? amount.toFixed(2) : amount.toFixed(0)}`;
}

export function age(createdAt: Date, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - createdAt.getTime()) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}
