const validator = require('validator');

function validate(data) {
    if (!data || typeof data !== 'object')
        throw new Error("Invalid request data");

    const mandatoryFields = ['username', 'emailId', 'firstname', 'password'];
    for (const field of mandatoryFields) {
        if (typeof data[field] !== 'string' || data[field].trim() === '')
            throw new Error(`${field} is required`);
    }

    // username: 3-20 chars, letters, numbers, underscore only
    const username = data.username.trim();
    if (!validator.isLength(username, { min: 3, max: 20 }))
        throw new Error("Username must be 3 to 20 characters");
    if (!/^[a-zA-Z0-9_]+$/.test(username))
        throw new Error("Username can contain only letters, numbers and underscore");

    // firstname: 2-20 chars, letters with optional single spaces/hyphens/apostrophes
    const firstname = data.firstname.trim();
    if (!validator.isLength(firstname, { min: 2, max: 20 }))
        throw new Error("First name must be 2 to 20 characters");
    if (!/^\p{L}+(?:[ '-]\p{L}+)*$/u.test(firstname))
        throw new Error("First name can contain only letters");

    if (!validator.isEmail(data.emailId))
        throw new Error("Invalid email");

    if (!validator.isStrongPassword(data.password))
        throw new Error("Password is too weak");
    if (data.password.length > 64)
        throw new Error("Password must be at most 64 characters");
}

module.exports = validate;