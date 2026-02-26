import { describe, it, expect } from "vitest";
import Workout from "../../src/models/Workout.js";
import { deleteWorkout } from "../../src/services/workoutsService.js";

import {
  createWorkout,
  updateWorkout,
  getWorkoutById,
} from "../../src/services/workoutsService.js";
import mongoose from "mongoose";

describe("workoutsService", () => {
  const userId = new mongoose.Types.ObjectId().toString();

  it("createWorkout normalizes muscleGroups (trim, title-case, dedupe, max length)", async () => {
    const saved = await createWorkout(userId, {
      date: new Date("2025-03-10"),
      muscleGroups: [
        "  back  ",
        "BACK",
        "chest",
        "Chest",
        "   ",
        "This Muscle Group Name Is Definitely Way Too Long To Be Allowed",
      ],
      exercises: [],
    });

    // read from DB to ensure persisted value is normalized
    const inDb = await Workout.findById(saved._id).lean();
    expect(inDb).toBeTruthy();
    expect(inDb?.muscleGroups).toEqual(["Back", "Chest"]);
    expect(String(inDb?.userId)).toEqual(userId);
  });

  it("updateWorkout normalizes muscleGroups when provided", async () => {
    const created = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [],
    });

    const updated = await updateWorkout(userId, created._id.toString(), {
      muscleGroups: [" legs ", "Legs", "back  "],
    });

    expect(updated.muscleGroups).toEqual(["Legs", "Back"]);
  });

  it("getWorkoutById throws 400 for invalid ObjectId", async () => {
    await expect(getWorkoutById(userId, "not-an-id")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("getWorkoutById throws 404 when workout not found", async () => {
    const missingId = new mongoose.Types.ObjectId().toString();

    await expect(getWorkoutById(userId, missingId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("getWorkoutById backfills missing set ids and persists them", async () => {
    const created = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [
        {
          id: "ex1",
          sets: [{ weight: 100, reps: 10 }], // missing set id on purpose
        },
      ],
    });

    const fetched = await getWorkoutById(userId, created._id.toString());

    // should now have generated set id
    expect(fetched.exercises[0].sets[0].id).toBeTruthy();

    // prove it was saved by reloading from DB
    const inDb = await Workout.findById(created._id).lean();
    expect(inDb?.exercises?.[0]?.sets?.[0]?.id).toBeTruthy();
  });

  it("getWorkoutById backfills missing set ids and persists them", async () => {
    const created = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [
        {
          id: "ex1",
          sets: [{ weight: 100, reps: 10 }], // missing set id on purpose
        },
      ],
    });

    const fetched = await getWorkoutById(userId, created._id.toString());

    // should now have generated set id
    expect(fetched.exercises[0].sets[0].id).toBeTruthy();

    // prove it was saved by reloading from DB
    const inDb = await Workout.findById(created._id).lean();
    expect(inDb?.exercises?.[0]?.sets?.[0]?.id).toBeTruthy();
  });

  it("updateWorkout updates date when provided", async () => {
    const created = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [],
    });

    const updated = await updateWorkout(userId, created._id.toString(), {
      date: new Date("2025-04-01"),
    });

    expect(updated.date.toISOString()).toBe(
      new Date("2025-04-01").toISOString(),
    );
  });

  it("deleteWorkout deletes and returns success true", async () => {
    const created = await Workout.create({
      userId,
      date: new Date("2025-03-10"),
      muscleGroups: ["Back"],
      exercises: [],
    });

    const res = await deleteWorkout(userId, created._id.toString());
    expect(res).toEqual({ success: true });

    const inDb = await Workout.findById(created._id).lean();
    expect(inDb).toBeNull();
  });

  it("deleteWorkout throws 404 when workout not found", async () => {
    const missingId = new mongoose.Types.ObjectId().toString();

    await expect(deleteWorkout(userId, missingId)).rejects.toMatchObject({
      status: 404,
    });
  });
});
