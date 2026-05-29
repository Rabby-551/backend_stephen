import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "../model/user.model.js";
import { Project } from "../model/project.model.js";
import { Manager } from "../model/manager.model.js";
import { Task } from "../model/task.model.js";
import { ProjectUpdate } from "../model/projectUpdate.model.js";
import { Comment } from "../model/comment.model.js";
import { Document } from "../model/document.model.js";
import { Chat } from "../model/chat.model.js";
import { Message } from "../model/message.model.js";
import { Notification } from "../model/notification.model.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { ensureChatRoom } from "../utils/chat.js";
import {
  createNotification,
  createNotificationsForUsers,
} from "../utils/notification.js";
import {
  deleteFromCloudinary,
  uploadOnCloudinary,
} from "../utils/commonMethod.js";
import { resolveScopedCategory } from "../utils/category.js";
import { syncAutoProgressForProject } from "../utils/projectAutoProgress.js";

const generateProjectCode = () =>
  `PRJ-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;

const normalizeProjectPhases = (phases = [], phase1 = []) => {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Add at least one phase to the project",
    );
  }

  const uniquePhaseNames = new Set();

  const normalizedPhases = phases.map((phase, index) => {
    const previousPhase = phase1[index];

    const phaseName = String(phase.phaseName || "").trim();
    const amount = Number(phase.amount);

    const dueDate =
      previousPhase?.dueDate || phase.dueDate || phase.paymentDate;

    const paymentStatus =
      previousPhase?.paymentStatus || phase.paymentStatus || "unpaid";

    const parsedDueDate = new Date(dueDate);

    if (
      !phaseName ||
      Number.isNaN(amount) ||
      amount < 0 ||
      Number.isNaN(parsedDueDate.getTime())
    ) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Each phase must include a valid name, amount, and payment date",
      );
    }

    const normalizedName = phaseName.toLowerCase();

    if (uniquePhaseNames.has(normalizedName)) {
      throw new AppError(
        httpStatus.CONFLICT,
        "Phase names must be unique within a project",
      );
    }

    uniquePhaseNames.add(normalizedName);

    return {
      phaseName,
      amount,
      dueDate,
      paymentStatus,
      notes: String(phase.notes || "").trim(),
    };
  });

  return normalizedPhases;
};

const calculateProjectBudget = (phases = []) =>
  phases.reduce((sum, phase) => sum + Number(phase.amount || 0), 0);

const parsePhasesInput = (value) => {
  if (Array.isArray(value)) {
    return value;
  }

  const raw = String(value || "").trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid phases payload");
  }
};

const parseStringArrayInput = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  const raw = String(value || "").trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    return [raw];
  }

  return [];
};

const parseClientAccountsInput = (value, fallback = {}) => {
  if (value === undefined || value === null || value === "") {
    if (!fallback.email) {
      return [];
    }

    return [
      {
        name: String(fallback.name || "").trim(),
        email: String(fallback.email || "")
          .trim()
          .toLowerCase(),
        password: String(fallback.password || "").trim(),
      },
    ];
  }

  const toAccountsArray = (input) => {
    if (Array.isArray(input)) {
      return input;
    }

    if (input && typeof input === "object") {
      const hasDirectAccountShape =
        "name" in input ||
        "email" in input ||
        "password" in input ||
        "clientName" in input ||
        "clientEmail" in input ||
        "clientPassword" in input;

      if (hasDirectAccountShape) {
        return [input];
      }

      return Object.values(input);
    }

    const raw = String(input || "").trim();
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      return toAccountsArray(parsed);
    } catch {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Invalid clientAccounts payload",
      );
    }
  };

  const parsed = toAccountsArray(value);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Add at least one client account to the project",
    );
  }

  const normalized = parsed.map((item, index) => {
    let account = item;
    if (typeof account === "string") {
      const rawAccount = account.trim();
      if (!rawAccount) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Client account ${index + 1} is empty`,
        );
      }

      try {
        account = JSON.parse(rawAccount);
      } catch {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Client account ${index + 1} is invalid`,
        );
      }
    }

    const name = String(account?.name || account?.clientName || "").trim();
    const email = String(account?.email || account?.clientEmail || "")
      .trim()
      .toLowerCase();
    const password = String(
      account?.password || account?.clientPassword || "",
    ).trim();

    if (!name || !email) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Client account ${index + 1} must include name and email`,
      );
    }

    return {
      name,
      email,
      password,
    };
  });

  const uniqueEmails = new Set();
  for (const account of normalized) {
    if (uniqueEmails.has(account.email)) {
      throw new AppError(
        httpStatus.CONFLICT,
        "Client account emails must be unique within a project",
      );
    }
    uniqueEmails.add(account.email);
  }

  return normalized;
};

const resolveClientUsers = async (clientAccounts, category) => {
  const clientUsers = [];
  let createdCount = 0;

  for (const account of clientAccounts) {
    const existingUser = await User.findOne({ email: account.email });

    if (!existingUser) {
      if (!account.password) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Password is required for new client account: ${account.email}`,
        );
      }

      const createdUser = await User.create({
        name: account.name,
        email: account.email,
        password: account.password,
        role: "client",
        category,
        isEmailVerified: true,
      });

      clientUsers.push(createdUser);
      createdCount += 1;
      continue;
    }

    if (existingUser.role !== "client") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Email belongs to a non-client account: ${account.email}`,
      );
    }

    let shouldSave = false;
    if (account.name && existingUser.name !== account.name) {
      existingUser.name = account.name;
      shouldSave = true;
    }
    if (category && existingUser.category !== category) {
      existingUser.category = category;
      shouldSave = true;
    }
    if (account.password) {
      existingUser.password = account.password;
      shouldSave = true;
    }
    if (shouldSave) {
      await existingUser.save();
    }

    clientUsers.push(existingUser);
  }

  return {
    clientUsers,
    createdCount,
  };
};

export const createManager = catchAsync(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const password = String(req.body.password || "");
  const phone = String(req.body.phone || "").trim();
  const dashboardCategory = resolveScopedCategory(req.user, req.body.category);

  if (!name || !email || !password) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Name, email and password are required",
    );
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new AppError(httpStatus.CONFLICT, "Manager email already exists");
  }

  let avatar = { public_id: "", url: "" };
  if (req.file?.buffer) {
    const uploaded = await uploadOnCloudinary(req.file.buffer, {
      folder: "manager_avatars",
    });
    avatar = {
      public_id: uploaded.public_id,
      url: uploaded.secure_url,
    };
  }

  const managerUser = await User.create({
    name,
    email,
    password,
    avatar,
    phone: phone || "",
    role: "manager",
    category: dashboardCategory,
    isEmailVerified: true,
  });

  await Manager.findOneAndUpdate(
    { user: managerUser._id },
    { user: managerUser._id },
    { upsert: true, new: true },
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Manager created successfully",
    data: {
      _id: managerUser._id,
      name: managerUser.name,
      email: managerUser.email,
      role: managerUser.role,
      avatar: managerUser.avatar,
      phone: managerUser.phone,
      category: managerUser.category,
    },
  });
});

export const getManagers = catchAsync(async (req, res) => {
  const dashboardCategory = resolveScopedCategory(req.user, req.query.category);

  const managers = await User.find({
    role: "manager",
    category: dashboardCategory,
    isActive: true,
  })
    .select("name email phone avatar assignedProjects createdAt category")
    .sort({ createdAt: -1 });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Managers fetched",
    data: managers,
  });
});

export const deleteManager = catchAsync(async (req, res) => {
  const { managerId } = req.params;
  const dashboardCategory = resolveScopedCategory(req.user, req.query.category);

  const manager = await User.findOne({
    _id: managerId,
    role: "manager",
    category: dashboardCategory,
    isActive: true,
  });

  if (!manager) {
    throw new AppError(httpStatus.NOT_FOUND, "Manager not found");
  }

  await Promise.all([
    User.findByIdAndUpdate(managerId, {
      $set: {
        isActive: false,
        refreshToken: "",
      },
    }),
    Manager.deleteOne({ user: managerId }),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Manager deleted successfully",
    data: null,
  });
});

export const createProject = catchAsync(async (req, res) => {
  const {
    projectName,
    category,
    phases: rawPhases,
    startDate,
    endDate,
    address,
    siteManagerId,
    clientName,
    clientEmail,
    clientPassword,
  } = req.body;
  const rawClientAccounts =
    req.body.clientAccounts ?? req.body.clients ?? req.body.clientUsers;
  const hasClientAccountsPayload =
    rawClientAccounts !== undefined &&
    rawClientAccounts !== null &&
    String(rawClientAccounts).trim() !== "";

  const missingFields = [
    !String(projectName || "").trim() ? "projectName" : null,
    !String(category || "").trim() ? "category" : null,
    !String(startDate || "").trim() ? "startDate" : null,
    !String(endDate || "").trim() ? "endDate" : null,
    !String(address || "").trim() ? "address" : null,
    !String(siteManagerId || "").trim() ? "siteManagerId" : null,
    !hasClientAccountsPayload && !String(clientName || "").trim()
      ? "clientName"
      : null,
    !hasClientAccountsPayload && !String(clientEmail || "").trim()
      ? "clientEmail"
      : null,
  ].filter(Boolean);

  if (missingFields.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Missing required project fields: ${missingFields.join(", ")}`,
    );
  }
  const dashboardCategory = resolveScopedCategory(req.user, category);

  const manager = await User.findOne({
    _id: siteManagerId,
    role: "manager",
    category: dashboardCategory,
    isActive: true,
  });
  if (!manager) {
    throw new AppError(httpStatus.NOT_FOUND, "Assigned manager not found");
  }

  const phases = parsePhasesInput(rawPhases);
  const normalizedPhases = normalizeProjectPhases(phases);
  const numericProjectBudget = calculateProjectBudget(normalizedPhases);

  const files = Array.isArray(req.files) ? req.files : [];
  const uploadedProjectImages = await Promise.all(
    files.map(async (file) => {
      const uploaded = await uploadOnCloudinary(file.buffer, {
        folder: "project_images",
      });
      return {
        public_id: uploaded.public_id,
        url: uploaded.secure_url,
      };
    }),
  );

  const clientAccounts = parseClientAccountsInput(rawClientAccounts, {
    name: clientName,
    email: clientEmail,
    password: clientPassword,
  });
  const { clientUsers, createdCount } = await resolveClientUsers(
    clientAccounts,
    dashboardCategory,
  );
  const primaryClient = clientUsers[0];

  const project = await Project.create({
    projectCode: generateProjectCode(),
    clientName: primaryClient.name,
    clientEmail: primaryClient.email,
    projectName,
    category: dashboardCategory,
    phases: normalizedPhases,
    projectBudget: numericProjectBudget,
    startDate,
    endDate,
    address,
    images: uploadedProjectImages,
    siteManager: manager._id,
    client: primaryClient._id,
    clientUsers: clientUsers.map((user) => user._id),
    createdBy: req.user._id,
  });

  await Promise.all([
    User.findByIdAndUpdate(manager._id, {
      $addToSet: { assignedProjects: project._id },
    }),
    ...clientUsers.map((user) =>
      User.findByIdAndUpdate(user._id, {
        $addToSet: { assignedProjects: project._id },
      }),
    ),
  ]);

  await ensureChatRoom({
    entityId: project._id,
    entityType: "Project",
    participants: [
      req.user._id,
      manager._id,
      ...clientUsers.map((user) => user._id),
    ],
    createdBy: req.user._id,
    title: `${project.projectName} Group Chat`,
  });

  await Promise.all([
    createNotification({
      user: manager._id,
      project: project._id,
      title: "New Project Assigned",
      message: `You have been assigned to project: ${project.projectName}`,
      type: "task_assigned",
    }),
    createNotificationsForUsers(
      clientUsers.map((user) => user._id),
      (userId) => ({
        user: userId,
        project: project._id,
        title: "Project Created",
        message: `Your project "${project.projectName}" is now active`,
        type: "task_assigned",
      }),
    ),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Project created successfully",
    data: {
      project,
      clientAccount: {
        isNewClient: createdCount > 0,
        count: clientUsers.length,
        emails: clientUsers.map((user) => user.email),
        clients: clientUsers.map((user) => ({
          _id: user._id,
          name: user.name,
          email: user.email,
          category: user.category,
        })),
      },
    },
  });
});

export const updateProject = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const {
    clientName,
    projectName,
    category,
    phases: rawPhases,
    startDate,
    endDate,
    address,
    siteManagerId,
  } = req.body;
  const rawClientAccounts =
    req.body.clientAccounts ?? req.body.clients ?? req.body.clientUsers;
  const hasClientAccountsPayload =
    rawClientAccounts !== undefined &&
    rawClientAccounts !== null &&
    String(rawClientAccounts).trim() !== "";

  const missingFields = [
    !hasClientAccountsPayload && !String(clientName || "").trim()
      ? "clientName"
      : null,
    !String(projectName || "").trim() ? "projectName" : null,
    !String(category || "").trim() ? "category" : null,
    !String(startDate || "").trim() ? "startDate" : null,
    !String(endDate || "").trim() ? "endDate" : null,
    !String(address || "").trim() ? "address" : null,
    !String(siteManagerId || "").trim() ? "siteManagerId" : null,
  ].filter(Boolean);

  if (missingFields.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Missing required project fields: ${missingFields.join(", ")}`,
    );
  }
  const dashboardCategory = resolveScopedCategory(req.user, category);

  const project = await Project.findOne({
    _id: projectId,
    category: dashboardCategory,
  });
  if (!project) {
    throw new AppError(httpStatus.NOT_FOUND, "Project not found");
  }

  const manager = await User.findOne({
    _id: siteManagerId,
    role: "manager",
    category: dashboardCategory,
    isActive: true,
  });
  if (!manager) {
    throw new AppError(httpStatus.NOT_FOUND, "Assigned manager not found");
  }

  const phases = parsePhasesInput(rawPhases);
  const normalizedPhases = normalizeProjectPhases(phases, project.phases);
  const previousManagerId = project.siteManager?.toString();
  const previousClientIds = (project.clientUsers || [project.client])
    .filter(Boolean)
    .map((id) => id.toString());
  const clientAccounts = parseClientAccountsInput(rawClientAccounts, {
    name: clientName,
    email: project.clientEmail,
  });
  const { clientUsers } = await resolveClientUsers(
    clientAccounts,
    dashboardCategory,
  );
  const nextClientIds = clientUsers.map((user) => user._id.toString());
  const removedClientIds = previousClientIds.filter(
    (clientId) => !nextClientIds.includes(clientId),
  );

  project.clientName = clientUsers[0].name;
  project.clientEmail = clientUsers[0].email;
  project.projectName = String(projectName).trim();
  project.category = dashboardCategory;
  project.phases = normalizedPhases;
  project.projectBudget = calculateProjectBudget(normalizedPhases);
  project.startDate = startDate;
  project.endDate = endDate;
  project.address = String(address).trim();
  project.siteManager = manager._id;
  project.client = clientUsers[0]._id;
  project.clientUsers = clientUsers.map((user) => user._id);

  const removedImagePublicIds = parseStringArrayInput(
    req.body.removedImagePublicIds,
  );
  if (removedImagePublicIds.length > 0) {
    const removableSet = new Set(removedImagePublicIds);
    const imagesToDelete = (project.images || []).filter((image) =>
      removableSet.has(String(image.public_id || "")),
    );

    project.images = (project.images || []).filter(
      (image) => !removableSet.has(String(image.public_id || "")),
    );

    await Promise.all(
      imagesToDelete.map((image) => deleteFromCloudinary(image.public_id)),
    );
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length > 0) {
    const uploadedProjectImages = await Promise.all(
      files.map(async (file) => {
        const uploaded = await uploadOnCloudinary(file.buffer, {
          folder: "project_images",
        });
        return {
          public_id: uploaded.public_id,
          url: uploaded.secure_url,
        };
      }),
    );

    project.images = [...(project.images || []), ...uploadedProjectImages];
  }

  await project.save();

  await Promise.all([
    User.findByIdAndUpdate(manager._id, {
      $addToSet: { assignedProjects: project._id },
    }),
    ...clientUsers.map((user) =>
      User.findByIdAndUpdate(user._id, {
        $set: { name: user.name, category: dashboardCategory },
        $addToSet: { assignedProjects: project._id },
      }),
    ),
  ]);

  if (previousManagerId && previousManagerId !== manager._id.toString()) {
    await User.findByIdAndUpdate(previousManagerId, {
      $pull: { assignedProjects: project._id },
    });
  }

  if (removedClientIds.length > 0) {
    await Promise.all(
      removedClientIds.map((clientId) =>
        User.findByIdAndUpdate(clientId, {
          $pull: { assignedProjects: project._id },
        }),
      ),
    );
  }

  const groupChat = await ensureChatRoom({
    entityId: project._id,
    entityType: "Project",
    participants: [
      project.createdBy,
      manager._id,
      ...clientUsers.map((user) => user._id),
    ].filter(Boolean),
    createdBy: project.createdBy,
    title: `${project.projectName} Group Chat`,
  });

  groupChat.participants = [
    ...new Set(
      [
        ...(groupChat.participants || []).map((id) => id.toString()),
        manager._id.toString(),
        project.createdBy.toString(),
        ...clientUsers.map((user) => user._id.toString()),
      ].filter(Boolean),
    ),
  ];
  await groupChat.save();

  if (previousManagerId && previousManagerId !== manager._id.toString()) {
    await createNotification({
      user: manager._id,
      project: project._id,
      title: "Project Assignment Updated",
      message: `You are now assigned to "${project.projectName}"`,
      type: "task_assigned",
    });
  }

  const updatedProject = await Project.findById(project._id)
    .populate("siteManager", "name email")
    .populate("client", "name email")
    .populate("clientUsers", "name email");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project updated successfully",
    data: updatedProject,
  });
});

export const assignManagerToProject = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const { siteManagerId } = req.body;
  const dashboardCategory = resolveScopedCategory(req.user, req.body.category);

  const project = await Project.findOne({
    _id: projectId,
    category: dashboardCategory,
  });
  if (!project) {
    throw new AppError(httpStatus.NOT_FOUND, "Project not found");
  }

  const manager = await User.findOne({
    _id: siteManagerId,
    role: "manager",
    category: dashboardCategory,
    isActive: true,
  });
  if (!manager) {
    throw new AppError(httpStatus.NOT_FOUND, "Manager not found");
  }

  const previousManager = project.siteManager?.toString();
  project.siteManager = manager._id;
  await project.save();

  await User.findByIdAndUpdate(manager._id, {
    $addToSet: { assignedProjects: project._id },
  });
  if (previousManager && previousManager !== manager._id.toString()) {
    await User.findByIdAndUpdate(previousManager, {
      $pull: { assignedProjects: project._id },
    });
  }

  const groupChat = await ensureChatRoom({
    entityId: project._id,
    entityType: "Project",
    participants: [
      project.createdBy,
      manager._id,
      ...(project.clientUsers || [project.client]).filter(Boolean),
    ],
    createdBy: project.createdBy,
    title: `${project.projectName} Group Chat`,
  });

  groupChat.participants = [
    ...new Set([
      ...(groupChat.participants || []).map((id) => id.toString()),
      manager._id.toString(),
      project.createdBy.toString(),
      ...(project.clientUsers || [project.client])
        .filter(Boolean)
        .map((id) => id.toString()),
    ]),
  ];
  await groupChat.save();

  await createNotification({
    user: manager._id,
    project: project._id,
    title: "Project Assignment Updated",
    message: `You are now assigned to "${project.projectName}"`,
    type: "task_assigned",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Manager assigned successfully",
    data: project,
  });
});

export const getAllProjects = catchAsync(async (req, res) => {
  const { status, search, manager } = req.query;
  const dashboardCategory = resolveScopedCategory(req.user, req.query.category);
  const query = { category: dashboardCategory };

  if (status) {
    query.projectStatus = status;
  }

  if (search) {
    query.$text = { $search: search };
  }

  if (manager) {
    query.siteManager = manager;
  }

  const projects = await Project.find(query)
    .populate("siteManager", "name email")
    .populate("client", "name email")
    .populate("clientUsers", "name email")
    .sort({ createdAt: -1 });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Projects fetched",
    data: projects,
  });
});

export const syncProjectAutoProgress = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const dashboardCategory = resolveScopedCategory(
    req.user,
    req.query.category || req.body.category,
  );

  const project = await Project.findOne({
    _id: projectId,
    category: dashboardCategory,
  });
  if (!project) {
    throw new AppError(httpStatus.NOT_FOUND, "Project not found");
  }

  const result = await syncAutoProgressForProject(project, {
    trigger: "admin-api",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.updated
      ? "Project progress synced from timeline"
      : "Project progress already up to date",
    data: {
      project: result.project,
      previousPercent: result.previousPercent,
      currentPercent: result.nextPercent,
      updated: result.updated,
    },
  });
});

export const getFinancialOverview = catchAsync(async (req, res) => {
  const dashboardCategory = resolveScopedCategory(req.user, req.query.category);
  const projects = await Project.find({ category: dashboardCategory }).populate(
    "client",
  );

  const totals = projects.reduce(
    (acc, project) => {
      acc.totalBudget += Number(project.projectBudget || 0);
      acc.totalPaid += Number(project.totalPaid || 0);
      acc.remainingBalance += Number(project.remainingBudget || 0);
      return acc;
    },
    { totalBudget: 0, totalPaid: 0, remainingBalance: 0 },
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Financial overview fetched",
    data: {
      totals,
      projects,
    },
  });
});

export const deleteProject = catchAsync(async (req, res) => {
  const { projectId } = req.params;
  const dashboardCategory = resolveScopedCategory(req.user, req.query.category);

  const project = await Project.findOne({
    _id: projectId,
    category: dashboardCategory,
  });
  if (!project) {
    throw new AppError(httpStatus.NOT_FOUND, "Project not found");
  }

  const clientIds = (project.clientUsers || [project.client])
    .filter(Boolean)
    .map((id) => id.toString());

  const [documents, updates, chats] = await Promise.all([
    Document.find({ project: project._id }),
    ProjectUpdate.find({ project: project._id }),
    Chat.find({ entityType: "Project", entityId: project._id }),
  ]);

  const updateIds = updates.map((update) => update._id);
  const taskIds = await Task.find({ project: project._id }).distinct("_id");
  const taskChats = await Chat.find({
    entityType: "Task",
    entityId: { $in: taskIds },
  });
  const allChats = [...chats, ...taskChats];
  const allChatIds = allChats.map((chat) => chat._id);

  const assetDeletePromises = [
    ...(project.images || []).map((image) =>
      deleteFromCloudinary(image.public_id),
    ),
    ...documents.map((doc) =>
      deleteFromCloudinary(doc.document?.public_id, { resource_type: "raw" }),
    ),
    ...updates.flatMap((update) => [
      ...(update.images || []).map((image) =>
        deleteFromCloudinary(image.public_id),
      ),
      ...(update.videos || []).map((video) =>
        deleteFromCloudinary(video.public_id, { resource_type: "video" }),
      ),
    ]),
  ];

  await Promise.all(assetDeletePromises);

  await Promise.all([
    Comment.deleteMany({ update: { $in: updateIds } }),
    Message.deleteMany({ chatRoom: { $in: allChatIds } }),
    Notification.deleteMany({
      $or: [
        { project: project._id },
        { task: { $in: taskIds } },
        { update: { $in: updateIds } },
        { chat: { $in: allChatIds } },
      ],
    }),
    Document.deleteMany({ project: project._id }),
    ProjectUpdate.deleteMany({ project: project._id }),
    Task.deleteMany({ project: project._id }),
    Chat.deleteMany({ _id: { $in: allChatIds } }),
    Project.deleteOne({ _id: project._id }),
    User.findByIdAndUpdate(project.siteManager, {
      $pull: { assignedProjects: project._id },
    }),
    ...clientIds.map((clientId) =>
      User.findByIdAndUpdate(clientId, {
        $pull: { assignedProjects: project._id },
      }),
    ),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Project deleted successfully",
    data: null,
  });
});
