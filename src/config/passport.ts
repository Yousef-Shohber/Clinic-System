import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import { User } from "../models/user.model";
import { Role } from "../types/enums";
import getEnv from "./env";

const env = getEnv();

export function initPassport(): void {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile: Profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            return done(new Error("No email returned from Google"));
          }

          const googleVerified = (
            profile as { _json?: { email_verified?: boolean | string } }
          )._json?.email_verified;
          if (googleVerified === false || googleVerified === "false") {
            return done(new Error("Google email is not verified"));
          }

          let user = await User.findOne({ email });

          if (user) {
            if (!user.googleId) {
              if (!user.isEmailVerified) {
                await User.updateOne(
                  { _id: user._id },
                  {
                    $set: { googleId: profile.id, isEmailVerified: true },
                    $unset: { password: 1 },
                  },
                );
                user = (await User.findById(user._id)) ?? user;
              } else {
                user.googleId = profile.id;
                await user.save();
              }
            }
            return done(null, user);
          }

          user = await User.create({
            name: profile.displayName,
            email,
            googleId: profile.id,
            isEmailVerified: true,
            role: Role.PATIENT,
            profilePhoto: {
              url:
                profile.photos?.[0]?.value ??
                "https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460__480.png",
              publicId: null,
            },
          });

          return done(null, user);
        } catch (error) {
          return done(error as Error);
        }
      },
    ),
  );
}

export default passport;
