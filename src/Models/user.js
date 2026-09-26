const mongoose = require('mongoose');
const {Schema} = mongoose;
const userSchema = new Schema({
    username:{
        type:String,
        unique:true,
        required:true,
        minlength:3,
        maxlength:20,
        trim: true,
        match: /^[a-zA-Z0-9_]+$/,
    },
    username_lower:{
        type:String,
        unique:true,
        required:true,
        trim: true,
        lowercase:true
    },
    emailId:{
        type:String,
        unique:true,
        required:true,
        trim: true,
        lowercase:true,
        immutable: true,
    },
    firstname:{
        type:String,
        required:true,
        minlength:2,
        maxlength:20,
        trim: true
    },
    lastname:{
        type:String,
        minlength:2,
        maxlength:20,
        trim: true
    },
    age:{
        type:Number,
        min:15,
        max:80
    },
    role:{
        type:String,
        enum:['user','admin'],
        default: 'user'
    },
    password: {
        type: String,
        required: true,
        select: false, // NEW (optional): password now only returned with .select('+password'); login already does this explicitly
    },
    lastSeenAt: { type: Date },
    avatar:{
        type:String,
        default:"https://i.pinimg.com/236x/12/a3/6a/12a36afc1d247b99b0ded978f38c339a.jpg?nii=t"
    },
    isActive:{
        type:Boolean,
        default:true
    },
    bio:{
        type:String,
        maxlength:150,
        default:""
    }

},{timestamps:true});

const User = mongoose.model("user",userSchema);

module.exports = User;