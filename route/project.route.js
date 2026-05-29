import express from "express";
import {
  addProjectPhase,
  addProjectProgressUpdate,
  deleteProjectProgressUpdate,
  getProjectDetails,
  getProjectFinancialSummary,
  getProjects,
  updatePhasePaymentStatus,
  updateProjectProgressUpdate,
  updateProjectStatus,
} from "../controller/project.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.get("/", getProjects);
router.get("/:projectId", getProjectDetails);
router.patch("/:projectId/status", updateProjectStatus);
router.post("/:projectId/progress", addProjectProgressUpdate);
router.patch("/:projectId/progress/:progressUpdateId", updateProjectProgressUpdate);
router.delete("/:projectId/progress/:progressUpdateId", deleteProjectProgressUpdate);
router.post("/:projectId/phases", addProjectPhase);
router.patch("/:projectId/phase-payment", updatePhasePaymentStatus);
router.get("/:projectId/financial-summary", getProjectFinancialSummary);

export default router;
