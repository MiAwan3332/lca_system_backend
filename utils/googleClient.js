import { google } from "googleapis";
import jwt from "jsonwebtoken";
import GoogleAccount from "../models/googleAccounts.js";
import { decryptToken, encryptToken } from "./googleCrypto.js";

export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/classroom.courses",
  "https://www.googleapis.com/auth/classroom.rosters",
  "https://www.googleapis.com/auth/classroom.coursework.students",
  "https://www.googleapis.com/auth/classroom.coursework.me",
  "https://www.googleapis.com/auth/classroom.topics",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.created",
];

const requiredEnv = (name) => {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
  return process.env[name];
};

export const createOAuthClient = () =>
  new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
    requiredEnv("GOOGLE_REDIRECT_URI")
  );

export const createGoogleState = (userId) =>
  jwt.sign(
    {
      userId,
      purpose: "google-oauth",
    },
    requiredEnv("JWT_SECRET"),
    { expiresIn: "15m" }
  );

export const verifyGoogleState = (state) => {
  const decoded = jwt.verify(state, requiredEnv("JWT_SECRET"));
  if (decoded?.purpose !== "google-oauth" || !decoded?.userId) {
    throw new Error("Invalid Google OAuth state");
  }
  return decoded;
};

export const getGoogleAuthUrl = (userId) => {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state: createGoogleState(userId),
  });
};

export const saveGoogleAccountTokens = async ({ userId, tokens, profile }) => {
  const update = {
    user: userId,
    email: profile?.email,
    name: profile?.name,
    google_user_id: profile?.id,
    scopes: String(tokens.scope || "")
      .split(" ")
      .filter(Boolean),
    access_token: encryptToken(tokens.access_token),
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
    is_connected: true,
    disconnected_at: null,
  };

  if (tokens.refresh_token) {
    update.refresh_token = encryptToken(tokens.refresh_token);
    update.connected_at = new Date();
  }

  return GoogleAccount.findOneAndUpdate({ user: userId }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
};

export const exchangeGoogleCode = async (code, userId) => {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data: profile } = await oauth2.userinfo.get();
  const account = await saveGoogleAccountTokens({ userId, tokens, profile });
  return { account, profile };
};

export const getAuthorizedGoogleClient = async (userId) => {
  const account = await GoogleAccount.findOne({
    user: userId,
    is_connected: true,
  });

  if (!account?.refresh_token && !account?.access_token) {
    throw new Error("Google account is not connected");
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: decryptToken(account.access_token),
    refresh_token: decryptToken(account.refresh_token),
    expiry_date: account.expiry_date,
    token_type: account.token_type,
  });

  client.on("tokens", async (tokens) => {
    const update = {};
    if (tokens.access_token) update.access_token = encryptToken(tokens.access_token);
    if (tokens.refresh_token) update.refresh_token = encryptToken(tokens.refresh_token);
    if (tokens.expiry_date) update.expiry_date = tokens.expiry_date;
    if (tokens.token_type) update.token_type = tokens.token_type;
    if (Object.keys(update).length > 0) {
      await GoogleAccount.findByIdAndUpdate(account._id, update);
    }
  });

  return client;
};

export const getGoogleServices = async (userId) => {
  const auth = await getAuthorizedGoogleClient(userId);
  return {
    auth,
    classroom: google.classroom({ version: "v1", auth }),
    calendar: google.calendar({ version: "v3", auth }),
    meet: google.meet({ version: "v2", auth }),
  };
};
