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

    await transporter.sendMail({
        from: `"Vartala" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Your Vartala Verification Code",
        text: `
Dear User,

We received a request to verify the email address associated with your Vartala account.

Your verification code is:

${otp}

This verification code is valid for 5 minutes and can be used only once.

For your security, please do not share this code with anyone. Vartala will never ask you to disclose your verification code or password.

If you did not request this verification code, no further action is required. You may safely ignore this email.

This is an automated message. Please do not reply to this email.

Regards,
Vartala Team
`
    });

    await client.set(`OTP:${email}`, otp, { EX: OTP_TTL });
    await client.set(`OTP:cooldown:${email}`, '1', { EX: RESEND_COOLDOWN });
    await client.del(`OTP:attempts:${email}`); // fresh OTP, fresh attempt count

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