/**
 * Copyright (c) 2024 Discover Financial Services
 */
export function loginHtml() {
    return `
<html>

<head>
    <style>

        .login-page {
            width: 360px;
            padding: 8% 0 0;
            margin: auto;
        }

        .form {
            position: relative;
            z-index: 1;
            background: #FFFFFF;
            max-width: 360px;
            margin: 0 auto 100px;
            padding: 45px;
            text-align: center;
            box-shadow: 0 0 20px 0 rgba(0, 0, 0, 0.2), 0 5px 5px 0 rgba(0, 0, 0, 0.24);
        }

        .form input {
            outline: 0;
            background: #f2f2f2;
            width: 100%;
            border: 0;
            margin: 0 0 15px;
            padding: 15px;
            box-sizing: border-box;
            font-size: 14px;
        }

        .form button {
            text-transform: uppercase;
            outline: 0;
            background: MediumSeaGreen;
            width: 100%;
            border: 0;
            padding: 15px;
            color: #FFFFFF;
            font-size: 14px;
            cursor: pointer;
        }

        .form button:hover,
        .form button:active,
        .form button:focus {
            background: #43A047;
        }

        .form .message {
            margin: 15px 0px;
            color: red;
            font-size: 12px;
        }

        body {
            font-family: sans-serif;
        }
    </style>
    <script>
        function getCookie(key) {
            var b = document.cookie.match("(^|;)\\\\s*" + key + "\\\\s*=\\\\s*([^;]+)");
            return b ? b.pop() : "";
        }
        function deleteCookie(key) {
            document.cookie = key + "=;expires=" + new Date(0).toUTCString();
        }
    </script>
</head>

<body>
    <div class="login-page">
        <div class="form">
            <h1>Log in</h1>
            <form action="/login" method="post" class="login-form">
                <input name="username" type="text" placeholder="Username" />
                <input name="password" type="password" placeholder="Password" />
                <div class="message" style="visibility:hidden;">
                </div>
                <button id="submit" type="submit">Log in</button>
            </form>
        </div>
    </div>
    <script>
        console.log("Running script");
        const message = getCookie("loginMessage");
        if (message) {
            const el = document.querySelector(".message")
            el.innerText = decodeURI(message);
            el.style.visibility = "visible";
            deleteCookie("loginMessage");
        }
    </script>
</body>

</html>
`;
}
