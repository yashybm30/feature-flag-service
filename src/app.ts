import {
  Body,
  Controller,
  Delete,
  Get,
  ForbiddenException,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { IsBoolean, IsString, Matches } from "class-validator";
import Redis from "ioredis";
import { Database } from "./database";
import { AuthGuard, AuthRequest, admin } from "./security";
export class FlagInput {
  @IsString() @Matches(/^[a-z][a-z0-9-]{1,63}$/) key!: string;
  @IsBoolean() enabled!: boolean;
}
export class SwitchInput {
  @IsBoolean() enabled!: boolean;
}
@Injectable()
export class Flags implements OnModuleDestroy {
  readonly redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  constructor(private readonly db: Database) {
    this.redis.on("error", () => undefined);
  }
  async evaluate(key: string, tenant: string) {
    const flag = await this.db.query(
      "SELECT enabled,killed,version FROM flags WHERE key=$1",
      [key],
    );
    if (!flag.rowCount) throw new NotFoundException("Flag not found");
    if (flag.rows[0].killed)
      return { key, enabled: false, reason: "kill-switch" };
    // Always check the authoritative kill switch and version before consulting Redis.
    const cacheKey = `flag:${tenant}:${key}:${flag.rows[0].version}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as unknown;
    } catch {
      /* Database fallback. */
    }
    const override = await this.db.query(
      "SELECT enabled FROM overrides WHERE flag_key=$1 AND tenant_id=$2",
      [key, tenant],
    );
    const result = {
      key,
      enabled: override.rowCount
        ? override.rows[0].enabled
        : flag.rows[0].enabled,
      reason: override.rowCount ? "tenant-override" : "global-default",
    };
    try {
      await this.redis.set(cacheKey, JSON.stringify(result), "EX", 15);
    } catch {
      /* Cache is optional. */
    }
    return result;
  }
  async onModuleDestroy() {
    this.redis.disconnect();
  }
}
@Controller("v1/flags")
@UseGuards(AuthGuard)
class Api {
  constructor(
    private readonly db: Database,
    private readonly flags: Flags,
  ) {}
  @Get() async list(@Query("offset") offset = "0") {
    const skip = Math.max(0, Math.min(10000, Number(offset) || 0));
    return (
      await this.db.query(
        "SELECT key,enabled,killed,version FROM flags ORDER BY key LIMIT 50 OFFSET $1",
        [skip],
      )
    ).rows;
  }
  @Get(":key/evaluate") evaluate(
    @Param("key") key: string,
    @Req() req: AuthRequest,
  ) {
    return this.flags.evaluate(key, req.actor.tenantId);
  }
  @Post() async create(@Body() body: FlagInput, @Req() req: AuthRequest) {
    admin(req.actor);
    if (req.actor.sub !== process.env.PLATFORM_ADMIN_SUB)
      throw new ForbiddenException("Platform operator required");
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        "INSERT INTO flags(key,enabled) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET enabled=EXCLUDED.enabled,version=flags.version+1,updated_at=now() RETURNING *",
        [body.key, body.enabled],
      );
      await tx.query(
        "INSERT INTO audit(actor_id,tenant_id,action,flag_key) VALUES($1,$2,$3,$4)",
        [req.actor.sub, req.actor.tenantId, "flag.upsert", body.key],
      );
      return result.rows[0];
    });
  }
  @Put(":key/override") async override(
    @Param("key") key: string,
    @Body() body: SwitchInput,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    return this.db.transaction(async (tx) => {
      const flag = await tx.query(
        "UPDATE flags SET version=version+1 WHERE key=$1 RETURNING key",
        [key],
      );
      if (!flag.rowCount) throw new NotFoundException();
      await tx.query(
        "INSERT INTO overrides(flag_key,tenant_id,enabled) VALUES($1,$2,$3) ON CONFLICT(flag_key,tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled",
        [key, req.actor.tenantId, body.enabled],
      );
      await tx.query(
        "INSERT INTO audit(actor_id,tenant_id,action,flag_key) VALUES($1,$2,$3,$4)",
        [req.actor.sub, req.actor.tenantId, "override.set", key],
      );
      return { key, enabled: body.enabled };
    });
  }
  @Delete(":key/override") async clear(
    @Param("key") key: string,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    await this.db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM overrides WHERE flag_key=$1 AND tenant_id=$2",
        [key, req.actor.tenantId],
      );
      await tx.query("UPDATE flags SET version=version+1 WHERE key=$1", [key]);
      await tx.query(
        "INSERT INTO audit(actor_id,tenant_id,action,flag_key) VALUES($1,$2,$3,$4)",
        [req.actor.sub, req.actor.tenantId, "override.clear", key],
      );
    });
    return { cleared: true };
  }
  @Put(":key/kill") async kill(
    @Param("key") key: string,
    @Body() body: SwitchInput,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    if (req.actor.sub !== process.env.PLATFORM_ADMIN_SUB)
      throw new ForbiddenException("Platform operator required");
    return this.db.transaction(async (tx) => {
      const r = await tx.query(
        "UPDATE flags SET killed=$2,version=version+1 WHERE key=$1 RETURNING *",
        [key, body.enabled],
      );
      if (!r.rowCount) throw new NotFoundException();
      await tx.query(
        "INSERT INTO audit(actor_id,tenant_id,action,flag_key) VALUES($1,$2,$3,$4)",
        [req.actor.sub, req.actor.tenantId, "kill.changed", key],
      );
      return r.rows[0];
    });
  }
  @Delete(":key") async remove(
    @Param("key") key: string,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    if (req.actor.sub !== process.env.PLATFORM_ADMIN_SUB)
      throw new ForbiddenException("Platform operator required");
    return this.db.transaction(async (tx) => {
      const deleted = await tx.query(
        "DELETE FROM flags WHERE key=$1 RETURNING key",
        [key],
      );
      if (!deleted.rowCount) throw new NotFoundException();
      await tx.query(
        "INSERT INTO audit(actor_id,tenant_id,action,flag_key) VALUES($1,$2,$3,$4)",
        [req.actor.sub, req.actor.tenantId, "flag.deleted", key],
      );
      return { deleted: true };
    });
  }
  @Get(":key/audit") async audit(
    @Param("key") key: string,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    return (
      await this.db.query(
        "SELECT action,actor_id,created_at FROM audit WHERE flag_key=$1 AND tenant_id=$2 ORDER BY id DESC LIMIT 100",
        [key, req.actor.tenantId],
      )
    ).rows;
  }
}
@Controller("health")
class Health {
  constructor(private readonly db: Database) {}
  @Get("live") live() {
    return { status: "alive" };
  }
  @Get("ready") async ready() {
    await this.db.query("SELECT 1 FROM flags LIMIT 1");
    return { status: "ready" };
  }
}
@Module({ controllers: [Api, Health], providers: [Database, Flags, AuthGuard] })
export class AppModule {}
