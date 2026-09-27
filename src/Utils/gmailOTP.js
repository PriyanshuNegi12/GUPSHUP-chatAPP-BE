const crypto = require("crypto");
const client = require("../Config/Redis");

const OTP_TTL = 300;          // 5 minutes
const RESEND_COOLDOWN = 60;   // 60 seconds
const MAX_ATTEMPTS = 5;

function createOTP() {
    return crypto.randomInt(100000, 1000000).toString();
}

async function sendOTPEmail(email, otp) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
            "api-key": process.env.BREVO_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body: JSON.stringify({
            sender: { name: "GUPSHUP", email: process.env.BREVO_SENDER_EMAIL },
            to: [{ email }],
            subject: "Your GUPSHUP Verification Code",
            textContent: `
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
`,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Brevo failed: ${res.status} ${errBody}`);
    }
}

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
    // but deliberately NOT awaited: even an HTTP call to Brevo can add a
    // noticeable delay, and we don't want signup to hang on mail delivery.
    // The OTP is already valid in Redis by the time we respond, so the user
    // can move straight to the "enter code" screen without waiting on it.
    await client.set(`OTP:${email}`, otp, { EX: OTP_TTL });
    await client.set(`OTP:cooldown:${email}`, '1', { EX: RESEND_COOLDOWN });
    await client.del(`OTP:attempts:${email}`); // fresh OTP, fresh attempt count

    sendOTPEmail(email, otp).catch((err) => {
        // fire-and-forget: log it so a real delivery failure (bad API key,
        // unverified sender, etc.) is still visible to you, even though the
        // user's request has already succeeded
        console.error(`[OTP email] failed to send to ${email}:`, err.message);
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