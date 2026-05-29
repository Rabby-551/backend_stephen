import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { Project } from "../model/project.model.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { buildProjectScope, getProjectForUser } from "../utils/projectAccess.js";
import {
  createNotification,
  createNotificationsForUsers,
} from "../utils/notification.js";

const sortProgressUpdatesNewestFirst = (project) => {
  if (!project) {
    return project;
  }

  const projectData = typeof project.toObject === "function" ? project.toObject() : project;
  const progressUpdates = Array.isArray(projectData.progressUpdates)
    ? [...projectData.progressUpdates].sort(
      (left, right) =>
        new Date(right?.updatedAt || 0).getTime() - new Date(left?.updatedAt || 0).getTime(),
    )
    : [];

  return {
    ...projectData,
    progressUpdates,
  };
};

const sortProjectProgressUpdatesForPersistence = (project) => {
  if (!project || !Array.isArray(project.progressUpdates)) {
    return;
  }

  project.progressUpdates.sort(
    (left, right) =>
      new Date(left?.updatedAt || 0).getTime() - new Date(right?.updatedAt || 0).getTime(),
  );
};

export const getProjects = catchAsync(async (req, res) => {
  const { status, search, category } = req.query;
  const scope = buildProjectScope(req.user, category);
  const query = { ...scope };

  if (status) {
    query.projectStatus = status;
  }

  if (search) {
    query.$text = { $search: search };
  }

  const projects = await Project.find(query)
    .populate("siteManager", "name email avatar")
    .populate("client", "name email avatar")
    .populate("clientUsers", "name email avatar")
    .sort({ createdAt: -1 });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Projects fetched",
    data: projects,
  });
});

export const getProjectDetails = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const scope = buildProjectScope(req.user, req.query.category);
  const project = await Project.findOne({ _id: projectId, ...scope })
    .populate("siteManager", "name email avatar")
    .populate("client", "name email avatar")
    .populate("clientUsers", "name email avatar")
    .populate("createdBy", "name email")
    .populate("progressUpdates.updatedBy", "name email avatar role");

  if (!project) {
    throw new AppError(httpStatus.NOT_FOUND, "Project not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project details fetched",
    data: sortProgressUpdatesNewestFirst(project),
  });
});

export const addProjectProgressUpdate = catchAsync(async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "Only admin/manager can update progress");
  }

  const { projectId } = req.params;
  const { progressName, percent, note } = req.body;

  if (!progressName || percent === undefined) {
    throw new AppError(httpStatus.BAD_REQUEST, "Progress name and percent are required");
  }

  const project = await getProjectForUser(projectId, req.user);

  project.progressUpdates.push({
    progressName,
    percent: Number(percent),
    note: note || "",
    updatedBy: req.user._id,
    updatedAt: new Date(),
  });
  sortProjectProgressUpdatesForPersistence(project);

  // Manual progress entries are informational only — they must never change
  // project status. Status is managed separately via updateProjectStatus.

  await project.save();
  await project.populate("progressUpdates.updatedBy", "name email avatar role");

  if (req.user.role === "manager") {
    await createNotificationsForUsers(
      project.clientUsers || [project.client],
      (userId) => ({
        user: userId,
        project: project._id,
        title: "Project Progress Updated",
        message: `${project.projectName} progress updated: ${progressName}`,
        type: "site_update",
      }),
    );
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Progress updated successfully",
    data: sortProgressUpdatesNewestFirst(project),
  });
});

export const updateProjectProgressUpdate = catchAsync(async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "Only admin/manager can update progress");
  }

  const { projectId, progressUpdateId } = req.params;
  const { progressName, percent, note } = req.body;

  if (!progressName || percent === undefined) {
    throw new AppError(httpStatus.BAD_REQUEST, "Progress name and percent are required");
  }

  const numericPercent = Number(percent);
  if (Number.isNaN(numericPercent) || numericPercent < 0 || numericPercent > 100) {
    throw new AppError(httpStatus.BAD_REQUEST, "Percent must be a number between 0 and 100");
  }

  const project = await getProjectForUser(projectId, req.user);
  const progressUpdate = project.progressUpdates.id(progressUpdateId);

  if (!progressUpdate) {
    throw new AppError(httpStatus.NOT_FOUND, "Progress update not found");
  }

  progressUpdate.progressName = String(progressName).trim();
  progressUpdate.percent = numericPercent;
  progressUpdate.note = String(note || "").trim();
  progressUpdate.updatedBy = req.user._id;
  progressUpdate.updatedAt = new Date();

  sortProjectProgressUpdatesForPersistence(project);

  // Manual progress entries are informational only — they must never change
  // project status. Status is managed separately via updateProjectStatus.

  await project.save();
  await project.populate("progressUpdates.updatedBy", "name email avatar role");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Progress updated successfully",
    data: sortProgressUpdatesNewestFirst(project),
  });
});

export const deleteProjectProgressUpdate = catchAsync(async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "Only admin/manager can delete progress entries");
  }

  const { projectId, progressUpdateId } = req.params;
  const project = await getProjectForUser(projectId, req.user);
  const progressUpdate = project.progressUpdates.id(progressUpdateId);

  if (!progressUpdate) {
    throw new AppError(httpStatus.NOT_FOUND, "Progress update not found");
  }

  progressUpdate.deleteOne();
  await project.save();
  await project.populate("progressUpdates.updatedBy", "name email avatar role");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Progress entry deleted",
    data: sortProgressUpdatesNewestFirst(project),
  });
});

export const updateProjectStatus = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const { projectStatus } = req.body;

  if (!["active", "finished"].includes(projectStatus)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid project status");
  }

  const project = await getProjectForUser(projectId, req.user);

  if (req.user.role === "client") {
    throw new AppError(httpStatus.FORBIDDEN, "Client cannot update project status");
  }

  project.projectStatus = projectStatus;
  await project.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project status updated",
    data: project,
  });
});

export const updatePhasePaymentStatus = catchAsync(async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "Only admin/manager can update phase payments");
  }

  const { projectId } = req.params;
  const { phaseName, paymentStatus, notes } = req.body;

  if (!phaseName || !["paid", "unpaid"].includes(paymentStatus)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Phase name and valid payment status required");
  }

  const project = await getProjectForUser(projectId, req.user);
  const phase = project.phases.find((item) => item.phaseName === phaseName);

  if (!phase) {
    throw new AppError(httpStatus.NOT_FOUND, "Phase not found in project");
  }

  phase.paymentStatus = paymentStatus;
  phase.paidAt = paymentStatus === "paid" ? new Date() : null;
  if (notes) {
    phase.notes = notes;
  }

  await project.save();

  await createNotificationsForUsers(
    project.clientUsers || [project.client],
    (userId) => ({
      user: userId,
      project: project._id,
      title: "Payment Phase Updated",
      message: `${phase.phaseName} payment marked as ${phase.paymentStatus}`,
      type: "payment_reminder",
    }),
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Phase payment updated",
    data: project,
  });
});

export const addProjectPhase = catchAsync(async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new AppError(httpStatus.FORBIDDEN, "Only admin/manager can add project phases");
  }

  const { projectId } = req.params;
  const { phaseName, amount, dueDate, paymentStatus = "unpaid", notes } = req.body;

  const normalizedPhaseName = String(phaseName || "").trim();
  const normalizedNotes = String(notes || "").trim();
  const numericAmount = Number(amount);
  const parsedDueDate = new Date(dueDate);

  if (!normalizedPhaseName || Number.isNaN(numericAmount) || numericAmount < 0 || Number.isNaN(parsedDueDate.getTime())) {
    throw new AppError(httpStatus.BAD_REQUEST, "Phase name, amount, and valid due date are required");
  }

  if (!["paid", "unpaid"].includes(paymentStatus)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid payment status");
  }

  const project = await getProjectForUser(projectId, req.user);
  const duplicatePhase = project.phases.some(
    (item) => item.phaseName.trim().toLowerCase() === normalizedPhaseName.toLowerCase(),
  );

  if (duplicatePhase) {
    throw new AppError(httpStatus.CONFLICT, "Phase already exists in project");
  }

  project.phases.push({
    phaseName: normalizedPhaseName,
    amount: numericAmount,
    dueDate: parsedDueDate,
    paymentStatus,
    paidAt: paymentStatus === "paid" ? new Date() : null,
    notes: normalizedNotes,
  });

  await project.save();

  await createNotificationsForUsers(
    project.clientUsers || [project.client],
    (userId) => ({
      user: userId,
      project: project._id,
      title: "New Project Phase Added",
      message: `${normalizedPhaseName} phase was added to ${project.projectName}`,
      type: "payment_reminder",
    }),
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Project phase created",
    data: project,
  });
});

export const getProjectFinancialSummary = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const project = await getProjectForUser(projectId, req.user, req.query.category);

  const totalBudget = Number(project.projectBudget || 0);
  const totalPaid = Number(project.totalPaid || 0);
  const remainingBalance = Math.max(totalBudget - totalPaid, 0);
  const paidPercentage = totalBudget > 0 ? Number(((totalPaid / totalBudget) * 100).toFixed(2)) : 0;

  const alerts = [];
  if (totalPaid > totalBudget) {
    const exceededBy = Number((((totalPaid - totalBudget) / totalBudget) * 100).toFixed(2));
    alerts.push(`Budget exceeded by ${exceededBy}%`);
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Financial summary fetched",
    data: {
      totalBudget,
      totalPaid,
      remainingBalance,
      paidPercentage,
      phases: project.phases,
      alerts,
    },
  });
});
