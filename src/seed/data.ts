import {
  CompensationChangeReason,
  EmployeeStatus,
  EmploymentType,
  MembershipRole,
  OrganizationStatus,
  UserStatus,
} from "@prisma/client";
import { BigNumber, decimal, toMoneyString } from "@/common/utils/number.js";
import {
  ACME_SANDBOX_SLUG,
  CONTROLLED_EMAIL_DOMAIN,
  CONTROLLED_USER_COUNT,
  GENERATED_SIZE_DISTRIBUTION,
  PAYLENS_DEMO_SLUG,
  SEED_AS_OF_DATE,
  SEED_EMPLOYEE_PREFIX,
  SEED_VERSION,
} from "./constants.js";
import { createEmployeeFaker, type SeedCountryCode } from "./faker.js";

export type OrganizationSize = keyof typeof GENERATED_SIZE_DISTRIBUTION;

export type SeedOrganization = {
  id: string;
  name: string;
  slug: string;
  size: "CANONICAL" | "EMPTY" | OrganizationSize;
  employeeCount: number;
  departmentCount: number;
};

export type SeedDepartment = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
};

export type SeedEmployee = {
  id: string;
  organizationId: string;
  departmentId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle: string;
  level: string;
  countryCode: string;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  hireDate: Date;
  terminationDate: Date | null;
};

export type SeedCompensation = {
  id: string;
  employeeId: string;
  annualBaseSalary: string;
  currency: string;
  effectiveFrom: Date;
  version: number;
};

export type SeedCompensationHistory = {
  id: string;
  employeeId: string;
  version: number;
  previousAnnualBaseSalary: string | null;
  newAnnualBaseSalary: string;
  previousCurrency: string | null;
  newCurrency: string;
  previousEffectiveFrom: Date | null;
  effectiveFrom: Date;
  reason: CompensationChangeReason;
  note: string;
  changedByUserId: string | null;
};

const DEMO_DEPARTMENTS = [
  ["ENG", "Engineering"],
  ["PRD", "Product"],
  ["DSN", "Design"],
  ["SLS", "Sales"],
  ["MKT", "Marketing"],
  ["FIN", "Finance"],
  ["PEO", "People"],
  ["LGL", "Legal"],
  ["OPS", "Operations"],
  ["CS", "Customer Success"],
  ["SUP", "Support"],
  ["SEC", "Security"],
  ["DATA", "Data"],
  ["IT", "IT"],
  ["STR", "Strategy"],
  ["PRC", "Procurement"],
] as const;

const SANDBOX_DEPARTMENTS = [
  ["ENG", "Engineering"],
  ["PEO", "People"],
  ["FIN", "Finance"],
  ["OPS", "Operations"],
] as const;

const GENERATED_DEPARTMENT_POOL = [
  ["ENG", "Engineering"],
  ["PRD", "Product"],
  ["SLS", "Sales"],
  ["OPS", "Operations"],
  ["FIN", "Finance"],
  ["PEO", "People"],
  ["MKT", "Marketing"],
  ["SUP", "Support"],
  ["DATA", "Data"],
  ["IT", "IT"],
  ["LGL", "Legal"],
  ["SEC", "Security"],
] as const;

const ORGANIZATION_SIZE_CONFIG: Record<
  OrganizationSize,
  { departmentCount: number; employeeBase: number }
> = {
  MICRO: { departmentCount: 2, employeeBase: 4 },
  SMALL: { departmentCount: 3, employeeBase: 15 },
  MEDIUM: { departmentCount: 5, employeeBase: 45 },
  LARGE: { departmentCount: 8, employeeBase: 220 },
  VERY_LARGE: { departmentCount: 12, employeeBase: 750 },
};

const ORGANIZATION_NAMES = [
  "Northstar Labs",
  "Meridian Works",
  "Cobalt Health",
  "Juniper Commerce",
  "Atlas Systems",
  "Harbor Studio",
  "Pioneer Foods",
  "Summit Cloud",
  "Oakline Services",
  "Solace Energy",
  "Brightwell Media",
  "Kestrel Logistics",
  "Willow Retail",
  "Vantage Analytics",
  "Copperfield Manufacturing",
  "Evergreen Mobility",
  "Redwood Health",
  "Aurora Learning",
  "Nimbus Networks",
  "Brookstone Finance",
  "Lighthouse Travel",
  "Crescent Legal",
  "Ironwood Security",
  "Meadow Technologies",
  "Stonebridge Partners",
  "Silverline Software",
  "Bluebird Ventures",
  "Cedar Operations",
] as const;

const TITLES = [
  "Associate",
  "Specialist",
  "Senior Specialist",
  "Lead",
  "Principal",
  "Director",
] as const;

const COUNTRIES = ["US", "GB", "DE", "IN"] as const;

const LEVELS = ["L1", "L2", "L3", "L4", "L5", "L6"] as const;

const generatedSizeSequence = Object.entries(GENERATED_SIZE_DISTRIBUTION).flatMap(([size, count]) =>
  Array.from({ length: count }, () => size as OrganizationSize),
);

const generatedEmployeeCount = (size: OrganizationSize, index: number): number =>
  ORGANIZATION_SIZE_CONFIG[size].employeeBase +
  index * (size === "VERY_LARGE" ? 50 : size === "LARGE" ? 12 : 2);

const COUNTRY_CURRENCY: Record<SeedCountryCode, string> = {
  US: "USD",
  GB: "GBP",
  DE: "EUR",
  IN: "INR",
};

const SALARY_BANDS: Record<SeedCountryCode, Record<(typeof LEVELS)[number], string>> = {
  US: { L1: "52000", L2: "72000", L3: "98000", L4: "130000", L5: "170000", L6: "220000" },
  GB: { L1: "32000", L2: "44000", L3: "58000", L4: "76000", L5: "100000", L6: "130000" },
  DE: { L1: "42000", L2: "55000", L3: "72000", L4: "94000", L5: "122000", L6: "155000" },
  IN: { L1: "600000", L2: "900000", L3: "1400000", L4: "2200000", L5: "3500000", L6: "5000000" },
};

export const DEPARTMENT_ADJUSTMENT_BPS: Record<string, number> = { ENG: 600, SEC: 700, DATA: 500 };

/** Deterministic per-record variation in basis points: -400..+400 (-4%..+4%). */
export const variationBpsFor = (index: number): number => (((index * 37) % 81) - 40) * 10;

export const seedId = (kind: string, value: string | number): string =>
  `${SEED_VERSION.toLowerCase()}-${kind}-${String(value).toLowerCase()}`;

export const generateOrganizations = (): SeedOrganization[] => [
  {
    id: seedId("org", PAYLENS_DEMO_SLUG),
    name: "PayLens Demo",
    slug: PAYLENS_DEMO_SLUG,
    size: "CANONICAL",
    employeeCount: 10_000,
    departmentCount: DEMO_DEPARTMENTS.length,
  },
  {
    id: seedId("org", ACME_SANDBOX_SLUG),
    name: "Acme Sandbox",
    slug: ACME_SANDBOX_SLUG,
    size: "EMPTY",
    employeeCount: 0,
    departmentCount: SANDBOX_DEPARTMENTS.length,
  },
  ...generatedSizeSequence.map((size, index) => {
    const sizeIndex = generatedSizeSequence
      .slice(0, index)
      .filter((candidate) => candidate === size).length;

    return {
      id: seedId("org", `generated-${String(index + 1).padStart(2, "0")}`),
      name: ORGANIZATION_NAMES[index],
      slug: `seed-${size.toLowerCase().replace("_", "-")}-${String(index + 1).padStart(2, "0")}`,
      size,
      employeeCount: generatedEmployeeCount(size, sizeIndex),
      departmentCount: ORGANIZATION_SIZE_CONFIG[size].departmentCount,
    };
  }),
];

export const generateDepartments = (organization: SeedOrganization): SeedDepartment[] => {
  const definitions =
    organization.slug === PAYLENS_DEMO_SLUG
      ? DEMO_DEPARTMENTS
      : organization.slug === ACME_SANDBOX_SLUG
        ? SANDBOX_DEPARTMENTS
        : GENERATED_DEPARTMENT_POOL.slice(0, organization.departmentCount);

  return definitions.map(([code, name]) => ({
    id: seedId("department", `${organization.slug}-${code}`),
    organizationId: organization.id,
    code,
    name,
  }));
};

export const generateControlledUsers = () =>
  Array.from({ length: CONTROLLED_USER_COUNT }, (_, index) => {
    const number = index + 1;

    return {
      id: seedId("user", number),
      email: `seed-r1.user${String(number).padStart(2, "0")}@${CONTROLLED_EMAIL_DOMAIN}`,
      firstName: `Demo${String(number).padStart(2, "0")}`,
      lastName: "User",
      emailVerifiedAt: SEED_AS_OF_DATE,
      status: UserStatus.ACTIVE,
    };
  });

export const generateMemberships = (organizations = generateOrganizations()) => {
  const demo = organizations.find((organization) => organization.slug === PAYLENS_DEMO_SLUG)!;
  const sandbox = organizations.find((organization) => organization.slug === ACME_SANDBOX_SLUG)!;

  const generated = organizations.filter(
    (organization) => organization.size !== "CANONICAL" && organization.size !== "EMPTY",
  );

  const demoRoles = [
    MembershipRole.TENANT_OWNER,
    MembershipRole.HR_ADMIN,
    MembershipRole.HR_MANAGER,
    MembershipRole.MANAGER,
    MembershipRole.VIEWER_AUDITOR,
  ];

  return [
    ...demoRoles.map((role, index) => ({
      organizationId: demo.id,
      userId: seedId("user", index + 1),
      role,
    })),
    { organizationId: sandbox.id, userId: seedId("user", 6), role: MembershipRole.TENANT_OWNER },
    { organizationId: sandbox.id, userId: seedId("user", 7), role: MembershipRole.HR_ADMIN },
    ...generated.map((organization, index) => ({
      organizationId: organization.id,
      userId: seedId("user", index + 8),
      role: MembershipRole.TENANT_OWNER,
    })),
  ];
};

const dateAtUtc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month, day));

export const generateEmployee = (
  organization: SeedOrganization,
  departments: SeedDepartment[],
  index: number,
): SeedEmployee => {
  const ordinal = index + 1;
  const department = departments[index % departments.length];
  const countryIndex = (index + organization.slug.length) % COUNTRIES.length;
  const countryCode = COUNTRIES[countryIndex];
  const faker = createEmployeeFaker(countryCode, organization.slug, ordinal);
  const levelIndex = Math.min(LEVELS.length - 1, Math.floor((index % 120) / 20));
  const hireYear = 2015 + ((index + organization.slug.length) % 9);
  const hireDate = dateAtUtc(hireYear, (index * 7) % 12, ((index * 11) % 28) + 1);

  return {
    id: seedId("employee", `${organization.slug}-${String(ordinal).padStart(5, "0")}`),
    organizationId: organization.id,
    departmentId: department.id,
    employeeNumber: `${SEED_EMPLOYEE_PREFIX}${organization.slug.toUpperCase()}-${String(ordinal).padStart(5, "0")}`,
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    workEmail: `${organization.slug}.employee${String(ordinal).padStart(5, "0")}@${CONTROLLED_EMAIL_DOMAIN}`,
    jobTitle: TITLES[levelIndex],
    level: LEVELS[levelIndex],
    countryCode,
    employmentType: index % 17 === 0 ? EmploymentType.CONTRACTOR : EmploymentType.FULL_TIME,
    status: index % 29 === 0 ? EmployeeStatus.ON_LEAVE : EmployeeStatus.ACTIVE,
    hireDate,
    terminationDate: null,
  };
};

export const generateEmployees = (
  organization: SeedOrganization,
  departments: SeedDepartment[],
): SeedEmployee[] =>
  Array.from({ length: organization.employeeCount }, (_, index) =>
    generateEmployee(organization, departments, index),
  );

let cachedDepartmentCodeById: Map<string, string> | null = null;

export const departmentCodeById = (): Map<string, string> => {
  if (!cachedDepartmentCodeById) {
    cachedDepartmentCodeById = new Map(
      generateOrganizations()
        .flatMap(generateDepartments)
        .map((department) => [department.id, department.code]),
    );
  }

  return cachedDepartmentCodeById;
};

const departmentCodeFor = (employee: SeedEmployee): string =>
  departmentCodeById().get(employee.departmentId) ?? "OPS";

export const salaryFor = (employee: SeedEmployee, index: number): string => {
  const country = employee.countryCode as SeedCountryCode;
  const level = employee.level as (typeof LEVELS)[number];
  const departmentCode = departmentCodeFor(employee);
  const totalBps = (DEPARTMENT_ADJUSTMENT_BPS[departmentCode] ?? 0) + variationBpsFor(index);
  const adjusted = decimal(SALARY_BANDS[country][level])
    .times(10_000 + totalBps)
    .dividedBy(10_000)
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);

  return toMoneyString(adjusted.toFixed(2));
};

export const generateCompensation = (employee: SeedEmployee, index: number): SeedCompensation => {
  const currency = COUNTRY_CURRENCY[employee.countryCode as SeedCountryCode];
  const version = index % 3 === 0 ? 3 : index % 2 === 0 ? 2 : 1;
  const effectiveFrom = dateAtUtc(2023 + version, 5, 1);

  return {
    id: seedId("compensation", employee.id),
    employeeId: employee.id,
    annualBaseSalary: salaryFor(employee, index),
    currency,
    effectiveFrom,
    version,
  };
};

export const generateCompensationHistory = ({
  employee,
  index,
  changedByUserId,
}: {
  employee: SeedEmployee;
  index: number;
  changedByUserId: string | null;
}): SeedCompensationHistory[] => {
  const current = generateCompensation(employee, index);

  const initial = decimal(current.annualBaseSalary)
    .times("0.88")
    .decimalPlaces(2, BigNumber.ROUND_HALF_UP);

  const step = decimal(current.annualBaseSalary).minus(initial).dividedBy(String(current.version));
  const versions = Array.from({ length: current.version }, (_, versionIndex) => versionIndex + 1);
  let previousSalary: string | null = null;
  let previousEffectiveFrom: Date | null = null;

  return versions.map((version) => {
    const newSalary =
      version === current.version
        ? current.annualBaseSalary
        : toMoneyString(initial.plus(step.times(String(version - 1))));

    const effectiveFrom = dateAtUtc(2023 + version, 5, 1);

    const entry = {
      id: seedId("compensation-history", `${employee.id}-${version}`),
      employeeId: employee.id,
      version,
      previousAnnualBaseSalary: previousSalary,
      newAnnualBaseSalary: newSalary,
      previousCurrency: version === 1 ? null : current.currency,
      newCurrency: current.currency,
      previousEffectiveFrom,
      effectiveFrom,
      reason:
        version === 1
          ? CompensationChangeReason.INITIAL
          : version === 2
            ? CompensationChangeReason.ANNUAL_REVIEW
            : CompensationChangeReason.PROMOTION,
      note: `${SEED_VERSION} deterministic compensation version ${version}`,
      changedByUserId,
    };

    previousSalary = newSalary;
    previousEffectiveFrom = effectiveFrom;

    return entry;
  });
};

export const expectedSeedEmployeeIds = (
  organizations: SeedOrganization[] = generateOrganizations(),
): string[] =>
  organizations.flatMap((organization) =>
    Array.from({ length: organization.employeeCount }, (_, index) =>
      seedId("employee", `${organization.slug}-${String(index + 1).padStart(5, "0")}`),
    ),
  );

/**
 * Canonical SEED-R1 employee ownership.
 *
 * The ONLY ownership authority is the deterministic canonical ID set.
 * The reserved `SEED-R1-` employee-number prefix is a diagnostic/collision
 * signal: a non-canonical row using it is a conflict, never seed-owned.
 */
export type EmployeeOwnership = "seed-owned" | "non-seed" | "reserved-prefix-conflict";

export const classifyEmployeeOwnership = (
  row: { id: string; employeeNumber: string },
  expectedIds: Set<string>,
): EmployeeOwnership => {
  if (expectedIds.has(row.id)) return "seed-owned";
  if (row.employeeNumber.startsWith(SEED_EMPLOYEE_PREFIX)) return "reserved-prefix-conflict";

  return "non-seed";
};

/**
 * Deterministic per-organization history actor map.
 *
 * Each actor is the most-privileged controlled member of THAT organization
 * (OWNER > ADMIN > HR > MANAGER, userId tie-break). Organizations with no
 * controlled member map to null (system-generated history). Never invents
 * users, never assigns a foreign organization's member, never changes the
 * frozen count of 35.
 */
const ACTOR_ROLE_PRIORITY: Record<MembershipRole, number> = {
  [MembershipRole.TENANT_OWNER]: 0,
  [MembershipRole.HR_ADMIN]: 1,
  [MembershipRole.HR_MANAGER]: 2,
  [MembershipRole.MANAGER]: 3,
  [MembershipRole.EMPLOYEE]: 4,
  [MembershipRole.VIEWER_AUDITOR]: 5,
};

export const organizationActorById = (
  organizations: SeedOrganization[] = generateOrganizations(),
  memberships: ReturnType<typeof generateMemberships> = generateMemberships(organizations),
): Map<string, string | null> => {
  const candidatesByOrg = new Map<string, { userId: string; role: MembershipRole }[]>();

  for (const membership of memberships) {
    const candidates = candidatesByOrg.get(membership.organizationId) ?? [];

    candidates.push({ userId: membership.userId, role: membership.role });
    candidatesByOrg.set(membership.organizationId, candidates);
  }

  const actors = new Map<string, string | null>();

  for (const organization of organizations) {
    const winner = (candidatesByOrg.get(organization.id) ?? [])
      .slice()
      .sort(
        (left, right) =>
          ACTOR_ROLE_PRIORITY[left.role] - ACTOR_ROLE_PRIORITY[right.role] ||
          (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0),
      )
      .at(0);

    actors.set(organization.id, winner?.userId ?? null);
  }

  return actors;
};

export const expectedTotalEmployees = (): number =>
  generateOrganizations().reduce((total, organization) => total + organization.employeeCount, 0);

export const salaryBands = SALARY_BANDS;

export const organizationStatus = OrganizationStatus.ACTIVE;
