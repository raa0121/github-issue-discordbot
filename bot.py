import datetime
import os
import pprint
import requests
import sys
from threading import Thread

import discord
import discordoauth2
from dotenv import load_dotenv
from flask import Flask, make_response, request
from github import Auth
from github import GithubIntegration

GUILD_ID = discord.Object(id=1044621674882007070)
discord_oauth2_client = discordoauth2.Client(
    os.getenv("DISCORD_CLIENT_ID"),
    secret=os.getenv("DISCORD_CLIENT_SECRET"),
    redirect="https://github-issue-discordbot.raa0121.info/callback_discord"
)
app = Flask(__name__)
GITHUB_INSTALLATION = {"330368501250261004": 73506487}
INTERACTION_REPOS = {}

class ReposDropdown(discord.ui.Select):
    def __init__(self, opts):
        options = [discord.SelectOption(label=opt) for opt in opts]
        super().__init__(placeholder='リポジトリを選んでください', min_values=1, max_values=1, options=options)

    async def callback(self, interaction: discord.Interaction):
        user_id = str(interaction.user.id)
        pprint.pp(interaction.data)
        INTERACTION_REPOS[user_id] = interaction.data["values"][0]
        pprint.pp(INTERACTION_REPOS)
        modal = CreateIssueModal()
        await interaction.response.send_modal(modal)

class DropdownView(discord.ui.View):
    def __init__(self, options):
        super().__init__()
        self.add_item(ReposDropdown(options))

class CreateIssueModal(discord.ui.Modal, title="Issueを作成します"):
    def __init__(self):
        super().__init__()

        issue_title = discord.ui.TextInput(label="issue タイトル", required=True)
        issue_body = discord.ui.TextInput(
            label="issue 本文",
            required=True,
            style=discord.TextStyle.long
        )

        self.add_item(issue_title)
        self.add_item(issue_body)

    async def on_submit(self, interaction: discord.Interaction):
        user_id = str(interaction.user.id)
        for repo in get_repos(GITHUB_INSTALLATION[user_id]):
            if repo.full_name == INTERACTION_REPOS[user_id]:
                break
        pprint.pp(repo)
        title = interaction.data["components"][0]["components"][0]["value"]
        body = interaction.data["components"][1]["components"][0]["value"]
        pprint.pp({'title': title, 'body': body})
        issue = repo.create_issue(title, body)
        await interaction.response.send_message(f"Issueが作成されました\n{issue.html_url}")

class MyClient(discord.Client):
    def __init__(self, *, intents: discord.Intents):
        super().__init__(intents=intents)
        self.tree = discord.app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        self.tree.copy_global_to(guild=GUILD_ID)
        await self.tree.sync(guild=GUILD_ID)

    async def on_ready(self):
        print(f'Logged on as {self.user}!')

    async def on_message(self, message):
        print(f'Message from {message.author}: {message.content}')

def get_repos(installation_id):
    auth = Auth.AppAuth(os.getenv("GITHUB_APP_CLIENT_ID"), os.getenv("GITHUB_APP_PRIVATE_KEY"))
    gi = GithubIntegration(auth=auth)
    return gi.get_app_installation(installation_id).get_repos()

def flask_init():
    @app.route("/")
    def hello_world():
        return "<p>hello</p>"

    @app.route("/callback_github")
    def callback_github():
        installation_id = request.args.get("installation_id")
        if installation_id is None:
            return "<p>Github App の install からアクセスしてください</p>"
        
        max_age = 300
        expires = int(datetime.datetime.now().timestamp()) + max_age
        response = make_response()
        response.set_cookie("installation_id", value=installation_id, expires=expires)
        response.headers["Location"] = "https://discord.com/oauth2/authorize?client_id=815097353228910643&response_type=code&redirect_uri=https%3A%2F%2Fgithub-issue-discordbot.raa0121.info%2Fcallback_discord&scope=identify"
        return response, 302

    @app.route("/callback_discord")
    def callback_discord():
        installation_id = request.cookies.get('installation_id')
        if installation_id is None:
            return "<p>Github App の認証が行われてません</p>"

        authorization_code = request.args.get("code")
        if authorization_code is None:
            return "<p>Discord の認証から来てください。</p>"
    
        request_postdata = {
            'client_id': os.getenv("DISCORD_CLIENT_ID"),
            'client_secret': os.getenv("DISCORD_CLIENT_SECRET"),
            'grant_type': 'authorization_code',
            'code': authorization_code,
            'redirect_uri': "https://github-issue-discordbot.raa0121.info/callback_discord"
        }
        accesstoken_request = requests.post('https://discord.com/api/oauth2/token', data=request_postdata)
    
        res = accesstoken_request.json()
        access_token = discordoauth2.AccessToken(res, client)
        identify = access_token.fetch_identify() 

        GITHUB_INSTALLATION[identify["id"]] = installation_id
        return "<p>認証が完了しました</p>"

    return app

def run():
    app.run(host="0.0.0.0")

if __name__ == '__main__':
    load_dotenv()
    app = flask_init()

    try:
        t = Thread(target=run)
        t.daemon = True
        t.start()
    except KeyboardInterrupt:
        sys.exit()

    intents = discord.Intents.default()
    intents.message_content = True

    DISCORD_TOKEN = os.getenv('DISCORD_TOKEN')

    client = MyClient(intents=intents)
    
    @client.tree.command()
    async def github_oauth(interaction: discord.Interaction):
        """Github OAuth"""
        await interaction.response.send_message('https://github.com/apps/issue-discordbot')

    @client.tree.command()
    async def check_auth(interaction: discord.Interaction):
        """認証済みか確認"""
        user_id = str(interaction.user.id)
        if user_id in GITHUB_INSTALLATION:
            repos = get_repos(GITHUB_INSTALLATION[user_id])
            repo_urls = "\n".join([repo.clone_url for repo in repos])
            await interaction.response.send_message(f"有効なリポジトリは以下です\n{repo_urls}")
        else:
            await interaction.response.send_message("認証されていません")

    @client.tree.command()
    async def create_issue(interaction: discord.Interaction):
        """Issueを作成します"""
        user_id = str(interaction.user.id)
        if user_id in GITHUB_INSTALLATION:
            repos = get_repos(GITHUB_INSTALLATION[user_id])
            view = DropdownView(list(map(lambda repo: repo.owner.login + "/" + repo.name, repos)))
            await interaction.response.send_message("どのリポジトリにIssueを立てますか？", view=view)
        else:
            await interaction.response.send_message("認証されていません")

    client.run(DISCORD_TOKEN)
