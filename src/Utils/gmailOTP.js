const nodemailer = require("nodemailer");
const crypto = require("crypto");
const client = require("../Config/Redis");

const OTP_TTL = 300;          // 5 minutes
const RESEND_COOLDOWN = 60;   // 60 seconds
const MAX_ATTEMPTS = 5;

function createOTP() {
    return crypto.randomInt(100000, 1000000).toString();
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
  // Force IPv4. Node's DNS resolver often returns Gmail's IPv6 address
  // first, and a lot of hosting providers only route IPv4 outbound —
  // that mismatch is what causes "connect ENETUNREACH 2404:..." even
  // though the credentials and everything else are fine.
  family: 4,
  connectionTimeout: 10000, // time to establish the TCP connection
  greetingTimeout: 10000,   // time to get the SMTP greeting after connecting
  socketTimeout: 15000,     // time for the whole send before giving up
});

async function generateOTP(data) {
    const email = data.emailId;

    const onCooldown = await client.exists(`OTP:cooldown:${email}`);
    if (onCooldown) {
        const ttl = await client.ttl(`OTP:cooldown:${email}`);
        const err = new Error(`Please wait ${ttl} seconds before requesting another OTP`);
        err.status = 429;
        throw err;
    }

    const otp = createOTP();

    // Store the OTP + cooldown FIRST and return right after — this is what
    // the client is actually waiting on. The email send below is kicked off
    // but deliberately NOT awaited: an SMTP round-trip (connect, auth,
    // transfer) can take several seconds even when it eventually succeeds,
    // which was exactly what made signup hang — sometimes long enough to
    // hit the hosting platform's own gateway timeout, which kills the
    // connection with no usable error ever reaching the browser. The OTP is
    // already valid in Redis by the time we respond, so the user can move
    // straight to the "enter code" screen without waiting on mail delivery.
    await client.set(`OTP:${email}`, otp, { EX: OTP_TTL });
    await client.set(`OTP:cooldown:${email}`, '1', { EX: RESEND_COOLDOWN });
    await client.del(`OTP:attempts:${email}`); // fresh OTP, fresh attempt count

    transporter.sendMail({
        from: `"GUPSHUP" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Your GUPSHUP Verification Code",
        text: `
Dear User,

We received a request to verify the email address associated with your GUPSHUP account.

Your verification code is:

${otp}

This verification code is valid for 5 minutes and can be used only once.

For your security, please do not share this code with anyone. GUPSHUP will never ask you to disclose your verification code or password.

If you did not request this verification code, no further action is required. You may safely ignore this email.

This is an automated message. Please do not reply to this email.

Regards,
GUPSHUP Team
`
    }).catch((err) => {
        // fire-and-forget: log it so a real delivery failure (bad
        // credentials, blocked network, etc.) is still visible to you,
        // even though the user's request has already succeeded
        console.error(`[OTP email] failed to send to ${email}:`, err);
    });

    return otp;
}

async function validateOTP(data) {
    const email = data.emailId;
    const otpKey = `OTP:${email}`;
    const attemptsKey = `OTP:attempts:${email}`;

    const storedOtp = await client.get(otpKey);
    if (!storedOtp) {
        const err = new Error("OTP expired or not found, please request a new one");
        err.status = 400;
        throw err;
    }

    if (typeof data.otp !== 'string' || data.otp !== storedOtp) {
        const attempts = await client.incr(attemptsKey);
        await client.expire(attemptsKey, OTP_TTL);

        if (attempts >= MAX_ATTEMPTS) {
            await client.del(otpKey);
            await client.del(attemptsKey);
            const err = new Error("Too many wrong attempts, please request a new OTP");
            err.status = 429;
            throw err;
        }
        return false;
    }

    await client.del(otpKey);
    await client.del(attemptsKey);
    return true;
}

module.exports = { generateOTP, validateOTP };