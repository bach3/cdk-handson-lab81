import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {aws_ec2 as ec2} from 'aws-cdk-lib';
import {aws_iam as iam} from 'aws-cdk-lib';
import {aws_autoscaling as autoscaling} from 'aws-cdk-lib';
import {aws_elasticloadbalancingv2 as elbv2} from 'aws-cdk-lib';
import {aws_route53 as route53} from 'aws-cdk-lib';
import {aws_route53_targets as route53Targets } from 'aws-cdk-lib';

export interface VpcStackProps extends StackProps {
  vpcName: string;
  vpcMaxAzs: number;
  vpcNatGateways: number;
  natGatewaySubnetCidr: number;
  ec2SubnetCidr: number;
  rdsSubnetCidr: number;
}

export class VpcStack extends Stack {
  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);

    const subnetConfig: ec2.SubnetConfiguration[] = [
      {
        cidrMask: props.natGatewaySubnetCidr,
        name: "pub-ec2",
        subnetType: ec2.SubnetType.PUBLIC,
      },
      {
        cidrMask: props.ec2SubnetCidr,
        name: "pri-ec2",
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      {
        cidrMask: props.rdsSubnetCidr,
        name: "pri-rds",
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    ];

    const vpc = new ec2.Vpc(this, props.vpcName, {
      vpcName: props.vpcName,
      maxAzs: props.vpcMaxAzs,
      natGateways: props.vpcNatGateways,
      subnetConfiguration : subnetConfig,
    });

    // Create a Security Group
    const securityGroup = new ec2.SecurityGroup(this, 'pub-ec2-sg', {
      vpc,
      description: 'HTTP access',
      securityGroupName: 'pub-ec2-sg'
    });
    //securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP access');

    // Create a role for EC2 instances
    const role = new iam.Role(this, 'MyEC2RoleForSSM', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // Create an instance profile
    const instanceProfile = new iam.CfnInstanceProfile(this, 'EC2InstanceProfile', {
      roles: [role.roleName]
    });

    // Create UserData script to install Apache server and display Hello, World!
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'yum update -y',
      'yum install -y httpd',
      'echo "<html><head><title>Hello, World!</title></head><body><h1>Hello, World!</h1></body></html>" > /var/www/html/index.html',
      'systemctl start httpd',
      'systemctl enable httpd'
    );

    // Create an EC2 instance
    // const instance = new ec2.Instance(this, 'MyEC2Instance', {
    //   instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MICRO),
    //   machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    //   vpc,
    //   securityGroup,
    //   role: role,
    //   vpcSubnets: {
    //     subnetType: ec2.SubnetType.PUBLIC,
    //   },
    //   userData : userData
    // });

    // Create an Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'MyAutoScalingGroup', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      minCapacity: 1,
      maxCapacity: 2,
      desiredCapacity: 2,
      associatePublicIpAddress: true,
      securityGroup,
      role: role,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      userData
    });

    // Create an Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'MyALB', {
      vpc,
      internetFacing: true,
      securityGroup,
    });

    // Create a target group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'MyTargetGroup', {
      port: 80,
      vpc,
      targetType: elbv2.TargetType.INSTANCE,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // Attach the target group to the load balancer
    targetGroup.addTarget(asg);

    // Add a listener to the ALB
    alb.addListener('Listener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Replace these with your domain name
    const domainName = 'subdomain.example.com';

    // Replace these with your hosted zone ID
    const hostedZoneId = 'XXXXXXXXXXXXXXXXXXXX';
    const hostedZoneName = 'example.com';

    // Fetch existing hosted zone
    //const zone = route53.HostedZone.fromHostedZoneId(this, 'MyHostedZone', hostedZoneId);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'MyHostedZone', {
      hostedZoneId: hostedZoneId,
      zoneName: hostedZoneName
    });
    // Create a record set for the ALB
    new route53.ARecord(this, 'AliasRecord', {
      recordName: domainName,
      zone,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });
  }
}