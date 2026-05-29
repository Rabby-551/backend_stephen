const MS_PER_DAY = 24 * 60 * 60 * 1000;

const toUtcDateOnly = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

export const calculateAutoProgressPercent = ({
  startDate,
  endDate,
  now = new Date(),
}) => {
  const normalizedStartDate = toUtcDateOnly(startDate);
  const normalizedEndDate = toUtcDateOnly(endDate);
  const normalizedToday = toUtcDateOnly(now);

  if (!normalizedStartDate || !normalizedEndDate || !normalizedToday) {
    return 0;
  }

  if (normalizedEndDate < normalizedStartDate) {
    return 0;
  }

  if (normalizedToday < normalizedStartDate) {
    return 0;
  }

  if (normalizedToday >= normalizedEndDate) {
    return 100;
  }

  const totalDays =
    Math.floor((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / MS_PER_DAY) + 1;
  const elapsedDays =
    Math.floor((normalizedToday.getTime() - normalizedStartDate.getTime()) / MS_PER_DAY) + 1;

  if (totalDays <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)));
};

/**
 * Updates project.progress with the date-based auto-timeline percentage.
 *
 * Rules:
 * - ONLY updates the project.progress numeric field (used by the top progress bar).
 * - Does NOT create any entry in project.progressUpdates (the manual feed).
 * - Does NOT change projectStatus — status is managed via the dedicated status endpoint.
 */
export const syncAutoProgressForProject = async (
  project,
  {
    trigger = "cron",
    now = new Date(),
  } = {},
) => {
  const currentPercent = Number(project.progress || 0);
  const calculatedPercent = calculateAutoProgressPercent({
    startDate: project.startDate,
    endDate: project.endDate,
    now,
  });

  // Never roll back — only advance the stored percentage forward.
  const nextPercent = Math.max(currentPercent, calculatedPercent);

  if (currentPercent === nextPercent) {
    return {
      updated: false,
      previousPercent: currentPercent,
      nextPercent,
      project,
    };
  }

  // Only persist project.progress — do not touch progressUpdates or projectStatus.
  project.progress = nextPercent;
  await project.save();

  return {
    updated: true,
    previousPercent: currentPercent,
    nextPercent,
    project,
  };
};
