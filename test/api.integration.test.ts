import "reflect-metadata";
import { beforeAll, afterAll, test, expect } from "vitest";
import { NestFactory } from "@nestjs/core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
const require = createRequire(import.meta.url);
const { AppModule } = require("../dist/app");
const { configure } = require("../dist/platform");
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  owner = randomUUID(),
  member = randomUUID();
function token(sub = owner, tenantId = tenant, role = "admin") {
  return jwt.sign({ sub, tenantId, role }, process.env.JWT_SECRET!, {
    issuer: "portfolio-auth",
    audience: "portfolio-api",
    expiresIn: 300,
  });
}
let app: Awaited<ReturnType<typeof NestFactory.create>>;
let api: ReturnType<typeof request>;
beforeAll(async () => {
  process.env.JWT_SECRET = "integration-only-signing-key-".repeat(3);
  process.env.PLATFORM_ADMIN_SUB = owner;
  await require("../dist/database").migrate();
  app = await NestFactory.create(AppModule, { logger: false });
  configure(app);
  await app.listen(0, "127.0.0.1");
  api = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});
test("global flags, tenant overrides, immediate kill switch and audit are authorized", async () => {
  const key = `flag-${randomUUID()}`;
  const op = { Authorization: `Bearer ${token()}` },
    second = { Authorization: `Bearer ${token(randomUUID(), otherTenant)}` };
  await api
    .post("/v1/flags")
    .set(second)
    .send({ key, enabled: true })
    .expect(403);
  await api.post("/v1/flags").set(op).send({ key, enabled: true }).expect(201);
  expect(
    (await api.get(`/v1/flags/${key}/evaluate`).set(op).expect(200)).body
      .enabled,
  ).toBe(true);
  await api
    .put(`/v1/flags/${key}/override`)
    .set(second)
    .send({ enabled: false })
    .expect(200);
  expect(
    (await api.get(`/v1/flags/${key}/evaluate`).set(second)).body.enabled,
  ).toBe(false);
  expect(
    (await api.get(`/v1/flags/${key}/evaluate`).set(op)).body.enabled,
  ).toBe(true);
  await api
    .put(`/v1/flags/${key}/kill`)
    .set(op)
    .send({ enabled: true })
    .expect(200);
  expect(
    (await api.get(`/v1/flags/${key}/evaluate`).set(op)).body.enabled,
  ).toBe(false);
  await api
    .post("/v1/flags")
    .set("Authorization", `Bearer ${token(member, tenant, "member")}`)
    .send({ key, enabled: false })
    .expect(403);
  expect((await api.get(`/v1/flags/${key}/audit`).set(op)).body.length).toBe(2);
  await api.get(`/v1/flags/${key}/evaluate`).expect(401);
  await api.delete(`/v1/flags/${key}`).set(second).expect(403);
  await api.delete(`/v1/flags/${key}`).set(op).expect(200);
  await api.get(`/v1/flags/${key}/evaluate`).set(op).expect(404);
  expect((await api.get(`/v1/flags/${key}/audit`).set(op)).body.length).toBe(3);
});
