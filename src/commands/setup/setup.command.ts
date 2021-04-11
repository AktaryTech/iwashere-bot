import {Command} from "../command";
import {CommandContext} from "../commandContext";
import {Guild, Message, Permissions, Snowflake, User} from "discord.js";
import {EventInputBuilder} from "../../models/builders/eventInputBuilder";
import {logger} from "../../logger";
import {BotConfig} from "../../config/bot.config";
import {EventService} from "../../interfaces/services/core/eventService";
import {TYPES} from "../../config/types";
import getDecorators from "inversify-inject-decorators";
import container from "../../config/inversify.config";
import {SetupState} from "../../interfaces/command/setup/setup.interface";
import {SetupDMChannelHandler} from "./handlers/setupDMChannelHandler";
import {EventInput} from "../../models/input/eventInput";
import {EventScheduleService} from "../../interfaces/services/schedule/eventScheduleService";
import {ChannelService} from "../../interfaces/services/discord/channelService";
import {BotEvent} from "../../models/core/event";

const { lazyInject } = getDecorators(container);

export default class SetupCommand extends Command{
    private setupUsers: Map<Snowflake, SetupState>;
    private readonly setupDMChannelHandler: SetupDMChannelHandler;

    @lazyInject(TYPES.EventService) readonly eventService: EventService;
    @lazyInject(TYPES.ChannelService) readonly channelService: ChannelService;
    @lazyInject(TYPES.EventScheduleService) readonly eventScheduleService: EventScheduleService;
    constructor() {
        super("setup", {
                                        aliases: [],
                                        commandType: {DMCommand: false, GuildCommand: true},
                                        botPermissions: [],
                                        memberPermissions: [Permissions.FLAGS.MANAGE_GUILD]});
        this.setupUsers = new Map();
        this.setupDMChannelHandler = new SetupDMChannelHandler(this);
    }

    protected async execute(commandContext: CommandContext): Promise<Message | Message[]> {
        const message = commandContext.message;
        const user = message.member.user;
        const guild = message.guild;

        if(this.userHasStartedSetup(user)){
            return await message.reply("You already have another setup initialized.");
        }

        return await this.initializeSetup(user, guild, message);
    }

    //TODO expiry clear user from map
    private async initializeSetup(user: User, guild: Guild, message: Message) {
        const defaultSetup = SetupCommand.getDefaultSetupNotInitialized(user, guild, message);

        if(!this.userHasStartedSetup(user)) {
            const initializedSetup = await this.initializeDMChannel(defaultSetup);
            this.setupUsers.set(user.id, initializedSetup);
            logger.info(`Initialized Setup for user ${initializedSetup.user} and guild ${guild}`);
        }

        return await message.reply("Setup initialized please continue configuration in DM");
    }

    private static getDefaultSetupNotInitialized(user: User, guild: Guild, message: Message){
        const defaultEventInput: EventInputBuilder = new EventInputBuilder()
            .setCreatedDate(new Date())
            .setCreatedBy(user.id)
            .setServer(guild.id);

        return {
            step: 0,
            user: user,
            guild: guild,
            channel: message.channel,
            dmChannel: undefined,
            event: defaultEventInput
        };
    }

    private async initializeDMChannel(defaultSetup: SetupState): Promise<SetupState>{
        const {user} = defaultSetup;
        const dmChannel = await this.channelService.createDMChannelWithHandler(user, this.setupDMChannelHandler);
        const initializedSetup: SetupState = {...defaultSetup, dmChannel: dmChannel};

        await this.sendInitialDM(initializedSetup);
        return initializedSetup;
    }

    private async sendInitialDM(setupState: SetupState){
        await setupState.dmChannel.send(`Hi ${setupState.user.username}! You want to set me up for an event in ${setupState.guild}? I'll ask for the details, one at a time.`);
        await setupState.dmChannel.send(`To accept the suggested value, respond with "${BotConfig.defaultOptionMessage}"`);
        await this.setupDMChannelHandler.sendInitMessage(setupState);
    }

    public userHasStartedSetup(user: User): boolean {
        return this.setupUsers.has(user.id);
    }

    public getSetupStateByUser(user: Snowflake): SetupState{
        if(!this.setupUsers.has(user))
            return undefined;
        return this.setupUsers.get(user);
    }

    public async clearSetupState(user: User): Promise<void>{
        const setupState = this.getSetupStateByUser(user.id);
        if(!setupState)
            return;

        try {
            await this.channelService.deleteUserDMChannel(user, "Setup finished");
            this.setupUsers.delete(user.id);
        }catch (e){
            logger.error(`ClearSetupState error: ${e}`);
        }
    }

    public async saveEvent(setupState: SetupState): Promise<Message>{
        logger.info(`[SetupCommand] Saving event for user id ${setupState.user.id} and guild id ${setupState.guild.id}`);
        logger.debug(`[SetupCommand] Saving event: ${JSON.stringify(setupState.event)}`);
        const event: EventInput = setupState.event.build();
        try {
            const savedEvent = await this.eventService.saveEvent(event, setupState.user.username);
            await this.eventScheduleService.scheduleEvent(savedEvent);
            return SetupCommand.checkSavedEvent(setupState, event, savedEvent);
        }catch(e){
            logger.error(`[SetupCommand] Error saving event, error: ${e}`);
            return await setupState.dmChannel.send(`Something went wrong, please try again in a few minutes or contact support.`);
        }
    }

    private static async checkSavedEvent(setupState: SetupState, eventInput: EventInput, savedEvent: BotEvent): Promise<Message>{
        logger.info(`[SetupCommand] Saved event: ${JSON.stringify(savedEvent)}`);
        if(eventInput.codes.length !== savedEvent.codes.length)
            return await setupState.dmChannel.send(`Event saved but some codes may be repeated. Please check with command !status and !setup addcodes to add more codes!`);

        return await setupState.dmChannel.send(`Thank you. That's everything. I'll start the event at the appointed time.`);
    }
}
