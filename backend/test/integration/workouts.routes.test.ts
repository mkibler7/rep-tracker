import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import Workout from "../../src/models/Workout.js";
import User from "../../src/models/User.js";

const app = createApp();

const getCookieValue = (
  setCookie: string | string[] | undefined,
  name: string,
) => {
  if (!setCookie) return undefined;

  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const line = arr.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;

  return line.split(";")[0].slice(name.length + 1);
};

describe("Workouts routes", () => {
  let agent: ReturnType<typeof request.agent>;
  let token: string;
  let userId: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    agent = request.agent(app);

    const email = `test-${Date.now()}@test.local`.toLowerCase();
    const password = "Password123!";

    const reg = await agent
      .post("/api/auth/register")
      .send({ email, password });
    if (reg.status !== 201) {
      throw new Error(`Register failed: ${reg.status} ${reg.text}`);
    }

    // Your schema uses emailVerifiedAt (as we confirmed in auth.routes.test.ts)
    await User.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });

    const loginRes = await agent
      .post("/api/auth/login")
      .send({ email, password });
    if (loginRes.status !== 200) {
      throw new Error(`Login failed: ${loginRes.status} ${loginRes.text}`);
    }

    // Prefer body token; fallback to cookie-based token if your login uses cookies.
    token =
      loginRes.body?.accessToken ??
      getCookieValue(loginRes.headers["set-cookie"], "at");

    // Prefer user.id from body; fallback to DB _id
    userId =
      loginRes.body?.user?.id ??
      (await User.findOne({ email }).lean())?._id?.toString();

    if (!token) throw new Error("No access token found after login");
    if (!userId) throw new Error("No userId found after login");

    await Workout.deleteMany({ userId });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const auth = (req: request.Test) =>
    req.set("Authorization", `Bearer ${token}`);

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(app).get("/api/workouts");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: "Missing access token" });
  });

  it("returns 401 when Bearer token is invalid", async () => {
    const res = await request(app)
      .get("/api/workouts")
      .set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: "Invalid or expired access token" });
  });

  it("GET /api/workouts returns workouts sorted from newest to oldest & returns valid id", async () => {
    await Workout.create([
      {
        userId,
        date: new Date("2025-01-01"),
        muscleGroups: ["Back"],
        exercises: [],
      },
      {
        userId,
        date: new Date("2025-02-01"),
        muscleGroups: ["Chest"],
        exercises: [],
      },
      {
        userId,
        date: new Date("2025-02-15"),
        muscleGroups: ["Quads", "Hamstrings"],
        exercises: [],
      },
    ]);

    const response = await auth(agent.get("/api/workouts"));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(3);

    const dates = response.body.map((w: any) => w.date);
    expect(dates).toEqual([
      new Date("2025-02-15").toISOString(),
      new Date("2025-02-01").toISOString(),
      new Date("2025-01-01").toISOString(),
    ]);
  });

  it("GET /api/workouts/:id returns 200 for a valid workout id", async () => {
    const workout = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [],
    });

    const response = await auth(
      agent.get(`/api/workouts/${workout._id.toString()}`),
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("id", workout._id.toString());
    expect(response.body.muscleGroups).toEqual(["Back"]);
    expect(response.body.date).toBe(new Date("2025-03-10").toISOString());
  });

  it("GET /api/workouts/:id returns 400 for invalid workout ID", async () => {
    const res = await auth(agent.get("/api/workouts/not-an-id"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Invalid id" });
  });

  it("POST /api/workouts creates a workout and normalizes muscle groups", async () => {
    const workout = {
      date: "2025-03-10",
      muscleGroups: ["  back  ", "", "BACK", "chest", "Chest", "   "],
      exercises: [],
    };

    const response = await auth(agent.post("/api/workouts").send(workout));

    expect(response.status).toBe(201);
    expect(
      typeof response.body.id === "string" ||
        typeof response.body._id === "string",
    ).toBe(true);

    expect(response.body.muscleGroups).toEqual(["Back", "Chest"]);
    expect(response.body.muscleGroups).toHaveLength(2);
  });

  it("POST /api/workouts returns 400 for invalid date", async () => {
    const workout = {
      date: "not-a-date",
      muscleGroups: ["Back"],
      exercises: [],
    };

    const response = await auth(agent.post("/api/workouts").send(workout));

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("message");
  });

  it("PUT /api/workouts/:id updates muscleGroups and normalizes values", async () => {
    const workout = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [],
    });

    const response = await auth(
      agent
        .put(`/api/workouts/${workout._id.toString()}`)
        .send({ muscleGroups: [" legs ", "Legs", "Back"] }),
    );

    expect(response.status).toBe(200);
    expect(response.body.muscleGroups).toEqual(["Legs", "Back"]);
  });

  it("PUT /api/workouts/:id returns 400 for invalid id", async () => {
    const res = await auth(
      agent.put("/api/workouts/not-an-id").send({ muscleGroups: ["Legs"] }),
    );

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("message");
  });

  it("DELETE /api/workouts/:id returns success true when deleted", async () => {
    const workout = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [],
    });

    const response = await auth(
      agent.delete(`/api/workouts/${workout._id.toString()}`),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
  });

  it("DEV ONLY: DELETE /api/workouts/__dev__/all returns 404 when ENABLE_DEV_ROUTES is not true", async () => {
    process.env.NODE_ENV = "test";
    process.env.ENABLE_DEV_ROUTES = "false";

    const res = await auth(agent.delete("/api/workouts/__dev__/all"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "Not found" });
  });

  it("DEV ONLY: DELETE /api/workouts/__dev__/all returns 403 in production even if ENABLE_DEV_ROUTES is true", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENABLE_DEV_ROUTES = "true";

    const res = await auth(agent.delete("/api/workouts/__dev__/all"));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "Forbidden" });
  });

  it("DEV ONLY: DELETE /api/workouts/__dev__/all deletes workouts when enabled and not production", async () => {
    process.env.NODE_ENV = "test";
    process.env.ENABLE_DEV_ROUTES = "true";

    await Workout.create([
      {
        userId,
        date: new Date("2025-01-01"),
        muscleGroups: ["Back"],
        exercises: [],
      },
      {
        userId,
        date: new Date("2025-02-01"),
        muscleGroups: ["Chest"],
        exercises: [],
      },
    ]);

    const res = await auth(agent.delete("/api/workouts/__dev__/all"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deletedCount");
    expect(typeof res.body.deletedCount).toBe("number");

    const remaining = await Workout.countDocuments({ userId });
    expect(remaining).toBe(0);
  });
});
