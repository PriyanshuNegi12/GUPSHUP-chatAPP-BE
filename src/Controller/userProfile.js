const User = require('../Models/user');
const validator = require('validator');

const MAX_AVATAR_BYTES = 350 * 1024; // decoded size cap — generous for a compressed square avatar

const PUBLIC_PROFILE = 'username firstname lastname emailId age role avatar bio createdAt';

const getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.result._id).select(PUBLIC_PROFILE).lean();
        if (!user) return res.status(404).json({ message: "User not found" });
        res.status(200).json({ user });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

// only accepts a data: URL (base64), which is what the client-side canvas
// compression produces — never a bare remote URL, so nothing here can be
// used to make the server fetch an attacker-controlled address
function validateAvatar(avatar) {
    if (typeof avatar !== 'string') return "Invalid avatar";
    const match = avatar.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return "Avatar must be a PNG, JPEG, or WEBP image";
    const decodedSize = Math.ceil((match[2].length * 3) / 4);
    if (decodedSize > MAX_AVATAR_BYTES) return "Avatar image is too large";
    return null;
}

const updateProfile = async (req, res) => {
    try {
        const body = req.body || {};
        const set = {};
        const unset = {};

        if (body.firstname !== undefined) {
            const firstname = String(body.firstname).trim();
            if (!validator.isLength(firstname, { min: 2, max: 20 }))
                return res.status(400).json({ message: "First name must be 2 to 20 characters" });
            if (!/^\p{L}+(?:[ '-]\p{L}+)*$/u.test(firstname))
                return res.status(400).json({ message: "First name can contain only letters" });
            set.firstname = firstname;
        }

        if (body.lastname !== undefined) {
            const lastname = String(body.lastname).trim();
            if (lastname === '') {
                unset.lastname = "";
            } else {
                if (!validator.isLength(lastname, { min: 2, max: 20 }))
                    return res.status(400).json({ message: "Last name must be 2 to 20 characters" });
                if (!/^\p{L}+(?:[ '-]\p{L}+)*$/u.test(lastname))
                    return res.status(400).json({ message: "Last name can contain only letters" });
                set.lastname = lastname;
            }
        }

        if (body.age !== undefined) {
            if (body.age === null || body.age === '') {
                unset.age = "";
            } else {
                const age = Number(body.age);
                if (!Number.isInteger(age) || age < 15 || age > 80)
                    return res.status(400).json({ message: "Age must be a whole number between 15 and 80" });
                set.age = age;
            }
        }

        if (body.bio !== undefined) {
            const bio = String(body.bio);
            if (bio.length > 150) return res.status(400).json({ message: "Bio must be at most 150 characters" });
            set.bio = bio;
        }

        if (body.avatar !== undefined) {
            const err = validateAvatar(body.avatar);
            if (err) return res.status(400).json({ message: err });
            set.avatar = body.avatar;
        }

        const update = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;

        if (!Object.keys(update).length)
            return res.status(400).json({ message: "Nothing to update" });

        const user = await User.findByIdAndUpdate(req.result._id, update, { new: true, runValidators: true })
            .select(PUBLIC_PROFILE).lean();

        res.status(200).json({ user, message: "Profile updated" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = { getProfile, updateProfile };