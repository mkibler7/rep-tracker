import { describe, it, expect } from "vitest";
import {
  parseCreateWorkoutInput,
  parseUpdateWorkoutInput,
} from "../../src/validators/workoutInput";

describe("workoutInput validators", () => {
  describe("parseCreateWorkoutInput", () => {
    it("parses valid input", () => {
      const parsed = parseCreateWorkoutInput({
        date: "2025-03-10",
        muscleGroups: [" Back "],
        exercises: [
          {
            id: "barbell-row",
            notes: "  good  ",
            sets: [{ weight: 135, reps: 8, tempo: " 3-1-1 ", rpe: 8 }],
          },
        ],
      });

      expect(parsed.date).toBeInstanceOf(Date);
      expect(parsed.date.toISOString().slice(0, 10)).toBe("2025-03-10");
      expect(parsed.muscleGroups).toEqual(["Back"]);
      expect(parsed.exercises?.[0].id).toBe("barbell-row");
      expect(parsed.exercises?.[0].notes).toBe("good");
      expect(parsed.exercises?.[0].sets[0]).toEqual({
        weight: 135,
        reps: 8,
        tempo: "3-1-1",
        rpe: 8,
      });
    });

    it("throws 400 when date is invalid", () => {
      expect(() =>
        parseCreateWorkoutInput({
          date: "not-a-date",
          muscleGroups: ["Back"],
          exercises: [],
        }),
      ).toThrow(/date is required and must be valid/i);
    });

    it("throws 400 when muscleGroups is empty after trimming", () => {
      expect(() =>
        parseCreateWorkoutInput({
          date: "2025-03-10",
          muscleGroups: ["   ", ""],
          exercises: [],
        }),
      ).toThrow(/muscleGroups must have at least one entry/i);
    });

    it("throws 400 when sets have non-positive weight/reps", () => {
      expect(() =>
        parseCreateWorkoutInput({
          date: "2025-03-10",
          muscleGroups: ["Back"],
          exercises: [{ id: "x", sets: [{ weight: 0, reps: 10 }] }],
        }),
      ).toThrow(/set weight must be a positive number/i);

      expect(() =>
        parseCreateWorkoutInput({
          date: "2025-03-10",
          muscleGroups: ["Back"],
          exercises: [{ id: "x", sets: [{ weight: 100, reps: 0 }] }],
        }),
      ).toThrow(/set reps must be a positive number/i);
    });

    it("throws 400 when rpe is out of range", () => {
      expect(() =>
        parseCreateWorkoutInput({
          date: "2025-03-10",
          muscleGroups: ["Back"],
          exercises: [{ id: "x", sets: [{ weight: 100, reps: 10, rpe: 11 }] }],
        }),
      ).toThrow(/set rpe must be between 1 and 10/i);
    });
  });

  describe("parseUpdateWorkoutInput", () => {
    it("supports patch semantics (only validates fields provided)", () => {
      const parsed = parseUpdateWorkoutInput({
        muscleGroups: ["  Legs ", "Back  "],
      });

      expect(parsed.date).toBeUndefined();
      expect(parsed.muscleGroups).toEqual(["Legs", "Back"]);
      expect(parsed.exercises).toBeUndefined();
    });

    it("throws 400 when no fields are provided", () => {
      expect(() => parseUpdateWorkoutInput({})).toThrow(/at least one field/i);
    });

    it("throws 400 when provided date is invalid", () => {
      expect(() =>
        parseUpdateWorkoutInput({
          date: "bad-date",
        }),
      ).toThrow(/date must be valid/i);
    });
  });
});
