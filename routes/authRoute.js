import express from "express";
import {
  register,
  login,
  logout,
  refresh,
  createUser,
} from "../controllers/authController.js";


const router = express.Router();

router.post("/register", register);
router.post("/user", createUser);
router.post("/login", login);
router.post("/logout", logout);
router.post("/refresh", refresh);

export default router;
