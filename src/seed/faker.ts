import { createHash } from "node:crypto";
import { Faker, fakerDE, fakerEN_GB, fakerEN_IN, fakerEN_US } from "@faker-js/faker";
import { SEED_VERSION } from "./constants.js";

export type SeedCountryCode = "US" | "GB" | "DE" | "IN";

const localeDefinitions = {
  US: fakerEN_US.rawDefinitions,
  GB: fakerEN_GB.rawDefinitions,
  DE: fakerDE.rawDefinitions,
  IN: fakerEN_IN.rawDefinitions,
} as const;

export const stableFakerSeed = (key: string): number =>
  createHash("sha256").update(key).digest().readUInt32BE(0);

export const createEmployeeFaker = (
  countryCode: SeedCountryCode,
  organizationSlug: string,
  ordinal: number,
): Faker => {
  const faker = new Faker({ locale: [localeDefinitions[countryCode]] });
  const key = `${SEED_VERSION}:${organizationSlug}:employee:${String(ordinal).padStart(5, "0")}:${countryCode}`;

  faker.seed(stableFakerSeed(key));

  return faker;
};
